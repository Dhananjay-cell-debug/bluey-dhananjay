package app.bluey.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.res.ResourcesCompat
import app.bluey.BlueyModel
import app.bluey.Palette
import app.bluey.R
import app.bluey.face.FaceRenderer
import app.bluey.link.LinkStatus
import kotlinx.coroutines.isActive

/** Shown until the phone is linked to the PC: a sleepy blob, how to wake him up, the pairing code, or an address. */
@Composable
fun PairingScreen(model: BlueyModel, onPlay: () -> Unit) {
    val status by model.linkStatus.collectAsState()
    val pcName by model.link.pcName.collectAsState()
    val found by model.link.found.collectAsState()
    val error by model.link.pairError.collectAsState()
    var manual by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize().background(Color.Black).clickable(enabled = false) {}, contentAlignment = Alignment.Center) {
        Row(Modifier.padding(horizontal = 56.dp), horizontalArrangement = Arrangement.spacedBy(48.dp), verticalAlignment = Alignment.CenterVertically) {
            SleepyBlob(Modifier.size(width = 210.dp, height = 180.dp))
            Column(Modifier.widthIn(max = 430.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                when {
                    error != null -> PairError(model, error!!)
                    status == LinkStatus.AWAITING_ALLOW -> CheckNumbers(model, pcName)
                    manual -> AddressEntry(model) { manual = false }
                    else -> {
                        Text("Wake me up from your PC", color = Color(0xFFF4F1FA), fontFamily = Fonts.fredoka, fontSize = 30.sp)
                        Text("Open Bluey on your Windows PC. Keep both on the same Wi-Fi and I'll find it (or plug in the USB cable).",
                            color = Palette.inkSoft, fontFamily = Fonts.plexSans, fontSize = 16.sp)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            CircularProgressIndicator(color = Palette.berry1, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                            Text(if (status == LinkStatus.CONNECTING) "Connecting to ${model.link.current.value?.name ?: "your PC"}…"
                                else if (found.isNotEmpty()) "Found ${found.first().name}" else "Looking for your PC",
                                color = Palette.inkSoft, fontFamily = Fonts.plexMono, fontSize = 13.sp)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            PillButton("Enter address") { manual = true }
                            PillButton("Play without the PC", onClick = onPlay)
                        }
                    }
                }
            }
        }
    }
}

/** Pairing: the same six digits show on the PC with an Allow button. */
@Composable
private fun CheckNumbers(model: BlueyModel, pcName: String?) {
    val numbers by model.link.numbers.collectAsState()
    val keyChanged by model.link.keyChanged.collectAsState()
    if (keyChanged) {
        Text("${pcName ?: "Your PC"} looks different", color = Color(0xFFF4F1FA), fontFamily = Fonts.fredoka, fontSize = 28.sp)
        Text("Its security key changed (maybe Bluey was reinstalled). Only trust it if the PC shows these same numbers.",
            color = Palette.inkSoft, fontFamily = Fonts.plexSans, fontSize = 15.sp)
    } else {
        Text("Check the numbers", color = Color(0xFFF4F1FA), fontFamily = Fonts.fredoka, fontSize = 30.sp)
        Text("${pcName ?: "Your PC"} is asking whether to let this phone in. Click Allow there if it shows the same numbers.",
            color = Palette.inkSoft, fontFamily = Fonts.plexSans, fontSize = 15.sp)
    }
    Text(numbers ?: "··· ···", color = Color.White, fontFamily = Fonts.plexMono, fontSize = 48.sp, letterSpacing = 4.sp)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        CircularProgressIndicator(color = Palette.berry1, strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
        Text("Waiting for you to click Allow on the PC", color = Palette.inkSoft, fontFamily = Fonts.plexMono, fontSize = 13.sp)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (keyChanged) PillButton("Trust this PC", primary = true) { model.link.trustPc() }
        PillButton("Cancel") { model.link.forget() }
    }
}

@Composable
private fun PairError(model: BlueyModel, error: String) {
    Text("Not paired", color = Color(0xFFF4F1FA), fontFamily = Fonts.fredoka, fontSize = 30.sp)
    Text(error, color = Color(0xFFFF8FAF), fontFamily = Fonts.plexSans, fontSize = 15.sp)
    PillButton("Try again", primary = true) { model.link.retryPairing() }
}

@Composable
private fun AddressEntry(model: BlueyModel, onBack: () -> Unit) {
    var text by remember { mutableStateOf("") }
    var bad by remember { mutableStateOf(false) }
    Text("Enter your PC's address", color = Color(0xFFF4F1FA), fontFamily = Fonts.fredoka, fontSize = 28.sp)
    Text("It's in Bluey's window on the PC, under Phone (like 192.168.1.20:47613).", color = Palette.inkSoft, fontFamily = Fonts.plexSans, fontSize = 15.sp)
    BasicTextField(
        value = text, onValueChange = { text = it; bad = false }, singleLine = true,
        textStyle = TextStyle(color = Color.White, fontFamily = Fonts.plexMono, fontSize = 20.sp),
        cursorBrush = SolidColor(Palette.berry2),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
        keyboardActions = KeyboardActions(onGo = { if (model.link.connectManually(text)) onBack() else bad = true }),
        modifier = Modifier.width(340.dp).clip(RoundedCornerShape(14.dp)).background(Palette.panel)
            .border(1.5.dp, Palette.berry2, RoundedCornerShape(14.dp)).padding(14.dp),
    )
    if (bad) Text("That doesn't look like an address.", color = Color(0xFFFF8FAF), fontFamily = Fonts.plexSans, fontSize = 14.sp)
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        PillButton("Connect", primary = true) { if (model.link.connectManually(text)) onBack() else bad = true }
        PillButton("Back", onClick = onBack)
    }
}

@Composable
fun PillButton(text: String, primary: Boolean = false, onClick: () -> Unit) {
    Box(Modifier.height(44.dp).clip(RoundedCornerShape(14.dp))
        .background(if (primary) Palette.brush else androidx.compose.ui.graphics.SolidColor(Palette.panel))
        .clickable(onClick = onClick).padding(horizontal = 18.dp), contentAlignment = Alignment.Center) {
        Text(text, color = Color(0xFFF4F1FA), fontFamily = Fonts.plexSans, fontSize = 15.sp)
    }
}

/** A sleepy little blob with closed eyes and floating z's. */
@Composable
private fun SleepyBlob(modifier: Modifier) {
    val context = LocalContext.current
    val renderer = remember { FaceRenderer(ResourcesCompat.getFont(context, R.font.fredoka)) }
    var t by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) { while (isActive) { androidx.compose.runtime.withFrameMillis { t = it } } }
    Canvas(modifier) {
        val s = t / 1000.0
        drawIntoCanvas { canvas ->
            val c = canvas.nativeCanvas
            val w = size.width; val h = size.height
            val breathe = 1f + 0.02f * wave(s, 1.1)
            c.save()
            c.scale(breathe, breathe, w / 2, h)
            renderer.blobPath(path, 0f, 0f, w, h)
            paint.shader = renderer.gradient(0f, 0f, w, h); paint.alpha = 230
            c.drawPath(path, paint); paint.shader = null; paint.alpha = 255
            paint.color = Palette.INK
            c.drawRoundRect(w / 2 - 13f * density - 46f * density, h / 2 - 18f * density - 3.5f * density, w / 2 - 13f * density, h / 2 - 18f * density + 3.5f * density, 4f * density, 4f * density, paint)
            c.drawRoundRect(w / 2 + 13f * density, h / 2 - 18f * density - 3.5f * density, w / 2 + 13f * density + 46f * density, h / 2 - 18f * density + 3.5f * density, 4f * density, 4f * density, paint)
            paint.color = Palette.NOSE
            c.drawOval(w / 2 + 4f * density - 9f * density, h / 2 + 21f * density - 6f * density, w / 2 + 4f * density + 9f * density, h / 2 + 21f * density + 6f * density, paint)
            c.restore()
            paint.typeface = ResourcesCompat.getFont(context, R.font.fredoka)
            paint.fontVariationSettings = "'wght' 700"
            paint.textSize = 26f * density; paint.color = Palette.BERRY3
            c.drawText("z", w / 2 + 110f * density, h / 2 - 95f * density - 4f * density * wave(s, 1.5) + 9f * density, paint)
            paint.textSize = 18f * density; paint.color = Palette.BERRY4
            c.drawText("z", w / 2 + 128f * density, h / 2 - 122f * density - 4f * density * wave(s, 1.5, 1.0) + 6f * density, paint)
        }
    }
}

private val path = android.graphics.Path()
private val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
