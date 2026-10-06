package app.bluey.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.bluey.BlueyModel
import app.bluey.Palette

@Composable
fun LearningScreen(model: BlueyModel) {
    val guide by model.learning.collectAsState()
    var draft by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { model.refreshLearning() }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Learning you", color = Color.White, fontFamily = Fonts.fredoka, fontSize = 28.sp)
        Text("Your methods, corrections and prompt style. One guide shared with your desktop. Teach him while you work; review what he remembers here.",
            color = Palette.inkSoft, fontFamily = Fonts.plexSans, fontSize = 14.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(if (guide.optBoolean("enabled", true)) "Learning is on" else "Learning is paused", color = Palette.berry1, modifier = Modifier.weight(1f).padding(top = 14.dp))
            Switch(guide.optBoolean("enabled", true), { model.setLearning(it) })
        }
        MemoryField(draft, { draft = it }, "Teach a preference or paste your prompt guide…")
        Text("Save to my guide", color = Palette.berry1, modifier = Modifier.clickable(enabled = draft.isNotBlank()) {
            model.saveMemory(null, "preference", draft); draft = ""
        }.padding(vertical = 8.dp))
        val items = guide.optJSONArray("items")
        if (items == null || items.length() == 0) Text("No memories yet. Try: ‘Remember, I write Claude prompts with context, requirements and a clear completion checklist.’",
            color = Palette.inkSoft, fontSize = 14.sp)
        if (items != null) for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            key(item.optString("id"), item.optLong("updated")) {
                var text by remember { mutableStateOf(item.optString("text")) }
                Column(Modifier.fillMaxWidth().background(Palette.panel, RoundedCornerShape(18.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(item.optString("kind").replace('_', ' ').uppercase(), color = Palette.berry1, fontFamily = Fonts.plexMono, fontSize = 11.sp)
                    MemoryField(text, { text = it }, "")
                    Text("${item.optString("source")} · used ${item.optInt("uses")} times", color = Palette.inkSoft, fontSize = 11.sp)
                    Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                        Text("Save changes", color = Palette.berry1, modifier = Modifier.clickable { model.saveMemory(item.optString("id"), item.optString("kind"), text) }.padding(vertical = 8.dp))
                        Text("Forget", color = Palette.red, modifier = Modifier.clickable { model.deleteMemory(item.optString("id")) }.padding(vertical = 8.dp))
                    }
                }
            }
        }
        Text("Learning remembers context; it does not retrain the model or automatically start tasks. Only your requests and corrections enter this guide.", color = Palette.inkSoft, fontSize = 12.sp)
    }
}

@Composable
private fun MemoryField(text: String, change: (String) -> Unit, hint: String) {
    BasicTextField(text, change, modifier = Modifier.fillMaxWidth().border(1.dp, Color.White.copy(alpha = 0.12f), RoundedCornerShape(12.dp)).padding(12.dp),
        textStyle = TextStyle(color = Color.White, fontFamily = Fonts.plexSans, fontSize = 14.sp), cursorBrush = SolidColor(Palette.berry1),
        decorationBox = { inner -> if (text.isBlank()) Text(hint, color = Palette.inkSoft, fontSize = 14.sp); inner() })
}
