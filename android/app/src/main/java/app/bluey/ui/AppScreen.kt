package app.bluey.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.bluey.BlueyModel
import app.bluey.Entry
import app.bluey.Mode
import app.bluey.Palette
import app.bluey.SessionDetail
import app.bluey.SessionSummary
import app.bluey.face.FaceRenderer
import app.bluey.link.LinkStatus
import java.text.DateFormat
import java.util.Date

/** Bluey's own app screen: start or end a session, past sessions and their transcripts, and settings. */
@Composable
fun AppScreen(model: BlueyModel, onClose: () -> Unit) {
    val detail by model.detail.collectAsState()
    var learningPage by remember { mutableStateOf(false) }
    BackHandler { if (learningPage) learningPage = false else if (detail != null) model.closeSession() else onClose() }
    LaunchedEffect(Unit) { model.refreshSessions() }
    Row(Modifier.fillMaxSize().background(Color.Black).clickable(enabled = false) {}) {
        Sidebar(model, onClose, { learningPage = !learningPage }, learningPage, Modifier.width(300.dp).fillMaxHeight().background(Palette.panel.copy(alpha = 0.6f)))
        Box(Modifier.weight(1f).fillMaxHeight()) {
            val d = detail
            if (learningPage) LearningScreen(model) else if (d == null) SessionList(model) else SessionView(model, d)
        }
    }
}

@Composable
private fun Sidebar(model: BlueyModel, onClose: () -> Unit, onLearning: () -> Unit, learningPage: Boolean, modifier: Modifier) {
    val status by model.linkStatus.collectAsState()
    val pcName by model.link.pcName.collectAsState()
    val mode by model.mode.collectAsState()
    val volume by model.volume.collectAsState()
    val showReplies by model.showReplies.collectAsState()
    val found by model.link.found.collectAsState()
    val current by model.link.current.collectAsState()
    val connected = status == LinkStatus.CONNECTED
    var typed by remember { mutableStateOf("") }
    val context = LocalContext.current

    Column(modifier.verticalScroll(rememberScrollState()).padding(22.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            MiniBluey(Modifier.size(54.dp, 48.dp))
            Column {
                Text("Bluey", color = Color.White, fontFamily = Fonts.fredoka, fontSize = 28.sp)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.size(7.dp).clip(CircleShape).background(if (connected) Palette.green else Palette.inkSoft.copy(alpha = 0.5f)))
                    Text(if (connected) pcName ?: "PC" else "Looking for your PC", color = Palette.inkSoft, fontFamily = Fonts.plexSans, fontSize = 12.sp, maxLines = 1)
                }
            }
        }

        val asleep = mode == Mode.ASLEEP
        Row(Modifier.fillMaxWidth().height(50.dp).clip(RoundedCornerShape(16.dp))
            .background(if (asleep) Palette.brush else SolidColor(Palette.red)).alpha(if (!connected && asleep) 0.5f else 1f)
            .clickable(enabled = connected || !asleep) { model.toggle(); if (asleep) onClose() },
            horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Icon(if (asleep) Icons.Filled.PlayArrow else Icons.Filled.Stop, null, tint = Color.White)
            Spacer(Modifier.width(10.dp))
            Text(if (asleep) "Start session" else "End session", color = Color.White, fontFamily = Fonts.fredoka, fontSize = 18.sp)
        }
        Text(if (asleep) "He listens the whole session. Hold his face to ask something, let go and he answers."
             else "Session running. Hold his face to ask; everything you say is saved to your notes on the PC.",
            color = Palette.inkSoft, fontFamily = Fonts.plexSans, fontSize = 12.sp)

        // Type to him (handy in a quiet room).
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Color(0xFF0D0C12))
            .border(1.dp, Color.White.copy(alpha = 0.1f), RoundedCornerShape(14.dp)).padding(start = 12.dp),
            verticalAlignment = Alignment.CenterVertically) {
            BasicTextField(typed, { typed = it }, singleLine = true, modifier = Modifier.weight(1f).padding(vertical = 12.dp),
                textStyle = TextStyle(color = Color.White, fontFamily = Fonts.plexSans, fontSize = 14.sp), cursorBrush = SolidColor(Palette.berry2),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { model.type(typed); typed = ""; onClose() }),
                decorationBox = { inner -> if (typed.isEmpty()) Text("Type to Bluey…", color = Palette.inkSoft, fontFamily = Fonts.plexSans, fontSize = 14.sp); inner() })
            Box(Modifier.size(44.dp).clickable(enabled = connected && typed.isNotBlank()) { model.type(typed); typed = ""; onClose() }, contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Filled.Send, "Send", tint = if (typed.isBlank()) Palette.inkSoft else Palette.berry1, modifier = Modifier.size(18.dp))
            }
        }

        HorizontalDivider(color = Color.White.copy(alpha = 0.08f))
        Text(if (learningPage) "← Sessions" else "✦ Learning", color = Palette.berry1, fontFamily = Fonts.fredoka, fontSize = 18.sp,
            modifier = Modifier.fillMaxWidth().clickable(onClick = onLearning).padding(vertical = 8.dp))
        Label("Voice & sounds")
        Slider(value = volume, onValueChange = { model.setVolume(it) }, colors = SliderDefaults.colors(thumbColor = Palette.berry1, activeTrackColor = Palette.berry2))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Show his replies on the phone", color = Color.White, fontFamily = Fonts.plexSans, fontSize = 14.sp, modifier = Modifier.weight(1f))
            Switch(showReplies, { model.setShowReplies(it) }, colors = SwitchDefaults.colors(checkedTrackColor = Palette.berry2))
        }
        if (found.size > 1) {
            Label("PC")
            for (pc in found) {
                Row(Modifier.fillMaxWidth().height(34.dp).clickable { model.link.choose(pc) }, verticalAlignment = Alignment.CenterVertically) {
                    Text(pc.name, color = Color.White, fontFamily = Fonts.plexSans, fontSize = 14.sp, maxLines = 1, modifier = Modifier.weight(1f))
                    if (current?.name == pc.name) Text(if (connected) "✓" else "…", color = Palette.berry2)
                }
            }
        }
        // Lets him use the phone for you (an Accessibility service you switch on once).
        if (app.bluey.BuildConfig.HANDS) {
            Text(if (app.bluey.hands.BlueyHands.enabled) "✓ Bluey can use this phone" else "Let Bluey use this phone", color = Palette.berry1,
                fontFamily = Fonts.plexSans, fontSize = 13.sp, modifier = Modifier.clickable { app.bluey.hands.BlueyHands.openSettings(context) })
        }
        // Xiaomi, Redmi, Huawei and some Samsungs stop background apps; this keeps him listening with the screen off.
        Text("Keep listening with the screen off", color = Palette.berry1, fontFamily = Fonts.plexSans, fontSize = 13.sp,
            modifier = Modifier.clickable { openBatterySettings(context) })
        if (connected) {
            Text("Pair again", color = Palette.berry1, fontFamily = Fonts.plexSans, fontSize = 13.sp, modifier = Modifier.clickable { model.link.forget() })
            if (mode != Mode.ASLEEP) Text("Stop him using the PC", color = Palette.berry1, fontFamily = Fonts.plexSans, fontSize = 13.sp,
                modifier = Modifier.clickable { model.stopActions() })
        }
        Row(Modifier.fillMaxWidth().height(44.dp).clip(RoundedCornerShape(14.dp)).background(Color.White.copy(alpha = 0.08f)).clickable(onClick = onClose),
            horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Text("☺  Back to his face", color = Color.White, fontFamily = Fonts.plexSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
        }
    }
}

@Composable
private fun Label(text: String) = Text(text.uppercase(), color = Palette.inkSoft, fontFamily = Fonts.plexMono, fontSize = 11.sp)

@Composable
private fun SessionList(model: BlueyModel) {
    val sessions by model.sessions.collectAsState()
    val status by model.linkStatus.collectAsState()
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(start = 22.dp, end = 22.dp, top = 20.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Sessions", color = Color.White, fontFamily = Fonts.fredoka, fontSize = 24.sp)
            Spacer(Modifier.weight(1f))
            Text("${sessions.size}", color = Palette.inkSoft, fontFamily = Fonts.plexMono, fontSize = 13.sp)
        }
        if (sessions.isEmpty()) {
            Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Text(if (status == LinkStatus.CONNECTED) "No sessions yet" else "Sessions live on your PC", color = Color.White, fontFamily = Fonts.fredoka, fontSize = 18.sp)
                Text(if (status == LinkStatus.CONNECTED) "Start one and your transcript and his replies show up here." else "Connect to see them here.",
                    color = Palette.inkSoft, fontFamily = Fonts.plexSans, fontSize = 13.sp)
            }
        } else {
            LazyColumn(Modifier.fillMaxSize().padding(horizontal = 22.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(sessions, key = { it.id }) { SessionRow(it) { model.openSession(it.id) } }
                item { Spacer(Modifier.height(20.dp)) }
            }
        }
    }
}

private fun duration(seconds: Double): String {
    val s = seconds.toLong()
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

private fun dateTime(ms: Long) = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(ms))
private fun time(ms: Long) = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(ms))

@Composable
private fun SessionRow(s: SessionSummary, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Palette.panel).clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(dateTime(s.started), color = Color.White, fontFamily = Fonts.plexSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                if (s.live) Text("LIVE", color = Color.Black, fontFamily = Fonts.plexMono, fontSize = 10.sp,
                    modifier = Modifier.clip(CircleShape).background(Palette.green).padding(horizontal = 6.dp, vertical = 1.dp))
            }
            Text(s.summary, color = Palette.inkSoft, fontFamily = Fonts.plexSans, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(duration(s.duration), color = Palette.inkSoft, fontFamily = Fonts.plexMono, fontSize = 12.sp)
            Text("${s.questions} asked", color = Palette.berry1, fontFamily = Fonts.plexMono, fontSize = 11.sp)
        }
    }
}

/** One session as a chat: what was said in grey, your questions in blue, his replies in white bubbles. */
@Composable
private fun SessionView(model: BlueyModel, s: SessionDetail) {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val list = rememberLazyListState()
    LaunchedEffect(s.entries.size) { if (s.entries.isNotEmpty()) list.animateScrollToItem(s.entries.size - 1) }
    LaunchedEffect(copied) { if (copied) { kotlinx.coroutines.delay(2000); copied = false } }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(horizontal = 22.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            RoundIcon(Icons.AutoMirrored.Filled.ArrowBack, "Back") { model.closeSession() }
            Column(Modifier.weight(1f)) {
                Text(if (s.started > 0) dateTime(s.started) else "Session", color = Color.White, fontFamily = Fonts.fredoka, fontSize = 20.sp)
                val asked = s.entries.count { it.kind == "asked" }
                if (s.started > 0) Text("${duration(((s.ended ?: System.currentTimeMillis()) - s.started) / 1000.0)} · $asked asked",
                    color = Palette.inkSoft, fontFamily = Fonts.plexMono, fontSize = 11.sp)
            }
            Row(Modifier.height(40.dp).clip(CircleShape).background(Palette.berry3).clickable {
                model.agentPrompt(s.id) { text ->
                    if (text != null) {
                        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Bluey notes", text))
                        copied = true
                    }
                }
            }.padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.ContentCopy, null, tint = Color.White, modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(6.dp))
                Text(if (copied) "Copied" else "Copy prompt for agent", color = Color.White, fontFamily = Fonts.plexSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
            }
            RoundIcon(Icons.Filled.Share, "Share") {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, exportText(s))
                context.startActivity(Intent.createChooser(send, "Share session"))
            }
            RoundIcon(Icons.Filled.Delete, if (confirmDelete) "Tap again to delete" else "Delete", tint = if (confirmDelete) Palette.red else Color.White) {
                if (confirmDelete) model.deleteSession(s.id) else confirmDelete = true
            }
        }
        if (confirmDelete) Text("Tap the bin again to delete this session and its notes on your PC.", color = Color(0xFFFF8FAF),
            fontFamily = Fonts.plexSans, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 22.dp))
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 22.dp), state = list, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(s.entries) { EntryView(it) }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

private fun exportText(s: SessionDetail): String {
    val names = mapOf("heard" to "Heard", "asked" to "You asked", "reply" to "Bluey", "report" to "Research")
    return (listOf("Bluey session, ${dateTime(s.started)}", "") + s.entries.map { "[${time(it.time)}] ${names[it.kind] ?: it.kind}: ${it.text}" }).joinToString("\n")
}

@Composable
private fun RoundIcon(icon: ImageVector, label: String, tint: Color = Color.White, onClick: () -> Unit) {
    Box(Modifier.size(40.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.08f)).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = tint, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun EntryView(e: Entry) {
    var open by remember { mutableStateOf(false) }
    when (e.kind) {
        "asked" -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Column(horizontalAlignment = Alignment.End, modifier = Modifier.widthIn(max = 460.dp)) {
                Text("You asked · ${time(e.time)}", color = Palette.berry1, fontFamily = Fonts.plexMono, fontSize = 10.sp)
                Text(e.text, color = Color.White, fontFamily = Fonts.plexSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
                    modifier = Modifier.clip(RoundedCornerShape(18.dp)).background(Palette.brush).padding(horizontal = 14.dp, vertical = 10.dp))
            }
        }
        "reply" -> Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MiniBluey(Modifier.size(28.dp, 25.dp))
            Text(e.text, color = Palette.ink, fontFamily = Fonts.fredoka, fontSize = 16.sp,
                modifier = Modifier.widthIn(max = 460.dp).clip(RoundedCornerShape(18.dp)).background(Color.White).padding(horizontal = 14.dp, vertical = 10.dp))
        }
        "report" -> {
            val parts = e.text.split("\n\n")
            Column(Modifier.padding(start = 36.dp, end = 80.dp).clip(RoundedCornerShape(18.dp)).background(Color(0xFFEEF0FF))
                .border(2.dp, Palette.berry2, RoundedCornerShape(18.dp)).clickable { open = !open }.padding(14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("🔎  " + (parts.firstOrNull() ?: "Research"), color = Palette.ink, fontFamily = Fonts.fredoka, fontSize = 16.sp, modifier = Modifier.weight(1f))
                    Box(Modifier.size(24.dp).clip(CircleShape).background(Palette.berry2), contentAlignment = Alignment.Center) {
                        Text(if (open) "−" else "+", color = Color.White, fontSize = 14.sp)
                    }
                }
                Text(parts.drop(1).joinToString("\n\n"), color = Palette.ink, fontFamily = Fonts.plexSans, fontSize = 14.sp,
                    maxLines = if (open) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
            }
        }
        else -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(time(e.time), color = Palette.inkSoft.copy(alpha = 0.7f), fontFamily = Fonts.plexMono, fontSize = 10.sp, modifier = Modifier.width(58.dp).padding(top = 3.dp))
            if (e.speaker != null) Text("Speaker ${e.speaker}", color = speakerColor(e.speaker), fontFamily = Fonts.plexMono, fontSize = 11.sp,
                modifier = Modifier.width(78.dp).padding(top = 2.dp))
            Text(e.text, color = Color.White.copy(alpha = 0.92f), fontFamily = Fonts.plexSans, fontSize = 15.sp)
        }
    }
}

private fun speakerColor(s: String): Color {
    val colors = listOf(0xFF8FB3FF, 0xFF5BE49B, 0xFFFFB86B, 0xFFFF9AD0, 0xFFC79BFF, 0xFF6BE3E0)
    return Color(colors[(s.firstOrNull()?.code ?: 0) % colors.size])
}

/** A tiny Bluey: the blob with two googly eyes. */
@Composable
fun MiniBluey(modifier: Modifier) {
    val renderer = remember { FaceRenderer(null) }
    Canvas(modifier) { drawIntoCanvas { renderer.mini(it.nativeCanvas, 0f, 0f, size.width, size.height) } }
}

/** Asks Android to let Bluey run in the background (and on Xiaomi phones, opens the battery saver page for him). */
@android.annotation.SuppressLint("BatteryLife")
fun openBatterySettings(context: Context) {
    val pm = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
    val intents = mutableListOf<Intent>()
    if (!pm.isIgnoringBatteryOptimizations(context.packageName)) {
        intents += Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, android.net.Uri.parse("package:" + context.packageName))
    }
    if (android.os.Build.MANUFACTURER.equals("Xiaomi", ignoreCase = true)) {
        intents += Intent("miui.intent.action.HIDDEN_APPS_CONFIG_ACTIVITY").putExtra("package_name", context.packageName).putExtra("package_label", "Bluey")
    }
    intents += Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + context.packageName))
    for (i in intents) {
        if (runCatching { context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess) return
    }
}
