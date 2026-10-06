package app.bluey.ui

import android.os.SystemClock
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Hearing
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.WbSunny
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.res.ResourcesCompat
import app.bluey.BlueyModel
import app.bluey.Mode
import app.bluey.Palette
import app.bluey.R
import app.bluey.face.FaceRenderer
import app.bluey.link.LinkStatus
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.sin

@Composable
fun BlueyRoot(model: BlueyModel, requestMic: () -> Unit) {
    val status by model.linkStatus.collectAsState()
    val needsMic by model.needsMicPermission.collectAsState()
    var showApp by remember { mutableStateOf(false) }
    var playAlone by remember { mutableStateOf(false) }

    LaunchedEffect(needsMic) { if (needsMic) requestMic() }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        FaceScreen(model)
        if (status != LinkStatus.CONNECTED && !playAlone) {
            PairingScreen(model, onPlay = { playAlone = true })
        }
        if (status == LinkStatus.CONNECTED) playAlone = false
        TopButtons(model, onOpenApp = { showApp = true })
        Toast(model)
        UpdateBanner(model)
        if (showApp) AppScreen(model, onClose = { showApp = false })
    }
}

/** His face, plus the gestures: double tap to wake him or put him back to sleep, press and hold to ask. */
@Composable
private fun FaceScreen(model: BlueyModel) {
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val renderer = remember { FaceRenderer(ResourcesCompat.getFont(context, R.font.fredoka)) }
    var frameTime by remember { mutableLongStateOf(0L) }
    val scope = rememberCoroutineScope()
    val mode by model.mode.collectAsState()

    LaunchedEffect(Unit) {
        while (isActive) { androidx.compose.runtime.withFrameNanos { frameTime = it } }
    }

    Box(Modifier.fillMaxSize()) {
        Canvas(
            Modifier.fillMaxSize().pointerInput(Unit) {
                // His eyes follow your finger while it's on the screen (watching only; taps and holds still work).
                awaitPointerEventScope {
                    while (true) {
                        val event = awaitPointerEvent(androidx.compose.ui.input.pointer.PointerEventPass.Initial)
                        val change = event.changes.firstOrNull() ?: continue
                        model.animator.touchGaze = if (change.pressed) {
                            Pair(((change.position.x / size.width) * 2 - 1).toDouble().coerceIn(-1.0, 1.0),
                                ((change.position.y / size.height) * 2 - 1).toDouble().coerceIn(-1.0, 1.0))
                        } else null
                    }
                }
            }.pointerInput(Unit) {
                detectTapGestures(
                    onDoubleTap = { model.toggle() },
                    onPress = {
                        var asking = false
                        val job: Job = scope.launch {
                            delay(300)  // a quick tap isn't a hold
                            asking = true
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            model.beginAsk()
                        }
                        tryAwaitRelease()
                        job.cancel()
                        if (asking) {
                            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                            model.endAsk()
                        }
                    },
                )
            },
        ) {
            @Suppress("UNUSED_VARIABLE") val tick = frameTime  // redraw every frame
            val f = model.animator.step(SystemClock.uptimeMillis() / 1000.0)
            drawIntoCanvas { renderer.draw(it.nativeCanvas, f, size.width, size.height) }
        }
        ModeIndicator(mode)
        ModelBadge(model)
        Caption(model)
    }
}

@Composable
private fun ModelBadge(model: BlueyModel) {
    val status by model.pcStatus.collectAsState()
    val mode by model.mode.collectAsState()
    val route = status?.optJSONObject("route")
    val name = route?.optString("model")?.takeIf { it.isNotBlank() && it != "null" }
    val brain = route?.optString("brain") ?: status?.optString("brain")
    val label = if (name == null) "Ready" else if (brain == "local") name else "${if (brain == "claude") "Claude" else "Codex"} · $name"
    if (mode != Mode.ASLEEP) Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.BottomEnd) {
        Row(Modifier.clip(RoundedCornerShape(14.dp)).background(Color(0xE61E1B29))
            .border(1.dp, Color.White.copy(alpha = 0.12f), RoundedCornerShape(14.dp)).padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(Palette.berry1))
            Spacer(Modifier.width(8.dp))
            Text(label, color = Palette.inkSoft, fontFamily = Fonts.plexMono, fontSize = 11.sp)
        }
    }
}

private data class Look(val color: Color, val label: String?, val icon: ImageVector, val border: Float, val pulse: Float)

/** Which mode he's in: a solid border hugging the screen (blue while he listens) and a small label in the corner. */
@Composable
private fun ModeIndicator(mode: Mode) {
    val look = when (mode) {
        Mode.ASLEEP -> Look(Palette.inkSoft, null, Icons.Filled.Visibility, 0f, 0f)
        Mode.WAKING -> Look(Color(0xFFFFD66B), "Waking up", Icons.Filled.WbSunny, 6f, 1.6f)
        Mode.LISTENING -> Look(Palette.listenBlue, "Listening · hold to ask", Icons.Filled.Hearing, 10f, 0f)
        Mode.ASKING -> Look(Palette.listenBlue, "I'm all ears", Icons.Filled.Mic, 16f, 1.2f)
        Mode.THINKING -> Look(Color(0xFFC79BFF), "Thinking", Icons.Filled.AutoAwesome, 8f, 1.1f)
        Mode.SPEAKING -> Look(Color(0xFFFF9AD0), "Replying", Icons.Filled.ChatBubble, 8f, 0f)
    }
    val border by animateFloatAsState(look.border, label = "border")
    var t by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(look.pulse) {
        if (look.pulse > 0) while (isActive) { androidx.compose.runtime.withFrameMillis { t = it / 1000f } }
    }
    val wave = if (look.pulse > 0) 0.5f + 0.5f * sin(t * look.pulse * 2 * PI.toFloat()) else 1f
    Box(Modifier.fillMaxSize()) {
        if (border > 0.5f) {
            Box(Modifier.fillMaxSize().alpha(if (look.pulse > 0) 0.65f + 0.35f * wave else 1f)
                .border(border.dp, look.color, RoundedCornerShape(36.dp)))
        }
        Row(
            Modifier.padding(start = (24 + border).dp, top = (14 + border).dp)
                .clip(CircleShape)
                .background(if (look.label == null) Color.White.copy(alpha = 0.06f) else look.color)
                .padding(horizontal = if (look.label == null) 9.dp else 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(look.icon, null, tint = if (look.label == null) look.color.copy(alpha = 0.7f) else Color.White, modifier = Modifier.size(16.dp))
            if (look.label != null) {
                Spacer(Modifier.width(7.dp))
                Text(look.label, color = Color.White, fontSize = 16.sp, fontFamily = Fonts.fredoka)
            }
        }
    }
}

/** His reply, as a little speech bubble at the top (it also pops up by his cursor on the PC). */
@Composable
private fun Caption(model: BlueyModel) {
    val caption by model.caption.collectAsState()
    val show by model.showReplies.collectAsState()
    val heard by model.heard.collectAsState()
    val mode by model.mode.collectAsState()
    Box(Modifier.fillMaxSize().padding(top = 18.dp), contentAlignment = Alignment.TopCenter) {
        AnimatedVisibility(show && caption.isNotBlank(), enter = fadeIn() + scaleIn(initialScale = 0.6f), exit = fadeOut() + scaleOut(targetScale = 0.85f)) {
            Text(caption, color = Palette.ink, fontFamily = Fonts.fredoka, fontSize = if (caption.length <= 60) 20.sp else 17.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 520.dp).padding(horizontal = 90.dp).clip(RoundedCornerShape(22.dp))
                    .background(Color.White).border(2.5.dp, Palette.berry2, RoundedCornerShape(22.dp))
                    .padding(horizontal = 20.dp, vertical = 12.dp))
        }
        AnimatedVisibility(show && caption.isBlank() && heard.isNotBlank() && mode == Mode.THINKING, enter = fadeIn(), exit = fadeOut()) {
            Text("“$heard”", color = Color.White.copy(alpha = 0.75f), fontFamily = Fonts.plexSans, fontSize = 15.sp,
                textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 520.dp).padding(horizontal = 90.dp))
        }
    }
}

/** The faint buttons in the top-right corner: sound (chirp volume, say hi, which PC) and his app (sessions, settings). */
@Composable
private fun TopButtons(model: BlueyModel, onOpenApp: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    var lastTouch by remember { mutableLongStateOf(0L) }
    val volume by model.volume.collectAsState()
    LaunchedEffect(lastTouch, open) {
        if (open) { delay(6000); open = false }  // tuck the panel away after a few quiet seconds
    }
    Box(Modifier.fillMaxSize().padding(top = 10.dp, end = 14.dp), contentAlignment = Alignment.TopEnd) {
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                FaintButton(Icons.Filled.GridView, "Open Bluey") { onOpenApp() }
                FaintButton(if (open) Icons.Filled.Close else if (volume < 0.01f) Icons.AutoMirrored.Filled.VolumeOff else Icons.AutoMirrored.Filled.VolumeUp,
                    if (open) "Close sound settings" else "Sound settings", bright = open) { open = !open; lastTouch = System.currentTimeMillis() }
            }
            AnimatedVisibility(open, enter = fadeIn() + scaleIn(initialScale = 0.9f), exit = fadeOut() + scaleOut(targetScale = 0.9f)) {
                SoundPanel(model) { lastTouch = System.currentTimeMillis() }
            }
        }
    }
}

@Composable
private fun FaintButton(icon: ImageVector, label: String, bright: Boolean = false, onClick: () -> Unit) {
    Box(Modifier.size(44.dp).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Box(Modifier.size(34.dp).clip(CircleShape).background(Color.White.copy(alpha = if (bright) 0.14f else 0.06f)), contentAlignment = Alignment.Center) {
            Icon(icon, label, tint = Color.White.copy(alpha = if (bright) 0.9f else 0.35f), modifier = Modifier.size(16.dp))
        }
    }
}

@Composable
private fun SoundPanel(model: BlueyModel, touched: () -> Unit) {
    val volume by model.volume.collectAsState()
    val mode by model.mode.collectAsState()
    val status by model.linkStatus.collectAsState()
    val found by model.link.found.collectAsState()
    val current by model.link.current.collectAsState()
    Column(Modifier.width(260.dp).clip(RoundedCornerShape(18.dp)).background(Palette.panel.copy(alpha = 0.95f)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("CHIRP VOLUME", color = Palette.inkSoft, fontFamily = Fonts.plexMono, fontSize = 12.sp)
            Spacer(Modifier.weight(1f))
            Text("${(volume * 100).toInt()}%", color = Color.White, fontFamily = Fonts.plexMono, fontSize = 13.sp)
        }
        Slider(value = volume, onValueChange = { model.setVolume(it); touched() },
            colors = SliderDefaults.colors(thumbColor = Palette.berry1, activeTrackColor = Palette.berry2))
        val connected = status == LinkStatus.CONNECTED
        Box(Modifier.fillMaxWidth().height(44.dp).clip(RoundedCornerShape(12.dp)).background(Palette.brush).alpha(if (connected) 1f else 0.4f)
            .clickable(enabled = connected) { model.sayHi(); touched() }, contentAlignment = Alignment.Center) {
            Text(if (mode == Mode.ASLEEP) "Wake him up" else "Say hi", color = Color.White, fontFamily = Fonts.plexSans, fontSize = 15.sp)
        }
        if (found.size > 1) {
            Text("PC", color = Palette.inkSoft, fontFamily = Fonts.plexMono, fontSize = 12.sp)
            for (pc in found) {
                Row(Modifier.fillMaxWidth().height(36.dp).clickable { model.link.choose(pc); touched() }, verticalAlignment = Alignment.CenterVertically) {
                    Text(pc.name, color = Color.White, fontFamily = Fonts.plexSans, fontSize = 14.sp, maxLines = 1, modifier = Modifier.weight(1f))
                    if (current?.name == pc.name) Text(if (connected) "✓" else "…", color = Palette.berry2)
                }
            }
        }
        if (!connected) Text("Connect to your PC to talk to him.", color = Palette.inkSoft, fontFamily = Fonts.plexSans, fontSize = 12.sp)
    }
}

/** "A new Bluey is ready": appears when the PC has a newer app, with Android's one-time OK if it is needed. */
@Composable
private fun UpdateBanner(model: BlueyModel) {
    val status by model.updater.status.collectAsState()
    val needs by model.updater.needsPermission.collectAsState()
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    androidx.compose.runtime.DisposableEffect(lifecycle) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, e -> if (e == androidx.lifecycle.Lifecycle.Event.ON_RESUME) model.updater.resume() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    Box(Modifier.fillMaxSize().padding(top = 18.dp), contentAlignment = Alignment.TopCenter) {
        AnimatedVisibility(status != null, enter = fadeIn(), exit = fadeOut()) {
            Row(verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.widthIn(max = 560.dp).clip(RoundedCornerShape(14.dp)).background(Palette.panel)
                    .border(1.dp, Palette.berry2, RoundedCornerShape(14.dp)).padding(horizontal = 16.dp, vertical = 10.dp)) {
                Text(status ?: "", color = Color.White, fontFamily = Fonts.plexSans, fontSize = 14.sp, modifier = Modifier.weight(1f, false))
                if (needs) Text("  Allow", color = Palette.berry2, fontFamily = Fonts.plexSans, fontSize = 14.sp, modifier = Modifier.clickable { model.updater.openPermission() }.padding(8.dp))
            }
        }
    }
}

@Composable
private fun Toast(model: BlueyModel) {
    val toast by model.toast.collectAsState()
    Box(Modifier.fillMaxSize().padding(bottom = 22.dp), contentAlignment = Alignment.BottomCenter) {
        AnimatedVisibility(toast != null, enter = fadeIn(), exit = fadeOut()) {
            Text(toast ?: "", color = Color.White, fontFamily = Fonts.plexSans, fontSize = 14.sp, textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 560.dp).clip(RoundedCornerShape(14.dp)).background(Palette.panel)
                    .border(1.dp, Palette.berry2, RoundedCornerShape(14.dp)).padding(horizontal = 16.dp, vertical = 10.dp))
        }
    }
}

/** For the bounce of the little sleepy blob on the pairing screen. */
internal fun wave(seconds: Double, speed: Double, phase: Double = 0.0) = sin(seconds * speed + phase).toFloat()

/** Seconds since boot, for animations. */
internal fun seconds() = SystemClock.uptimeMillis() / 1000.0
