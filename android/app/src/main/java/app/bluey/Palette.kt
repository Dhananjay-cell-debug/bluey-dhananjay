package app.bluey

import android.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color as ComposeColor

/** Blueberry colors from the design canvas. */
object Palette {
    const val BERRY1 = 0xFFA9BCFF.toInt()  // light periwinkle
    const val BERRY2 = 0xFF6C86F5.toInt()
    const val BERRY3 = 0xFF4254D6.toInt()
    const val BERRY4 = 0xFF2B2F8F.toInt()  // deep indigo
    const val NOSE = 0xFF1C1F66.toInt()
    const val INK = 0xFF17151F.toInt()
    const val INK_SOFT = 0xFFB9B2CC.toInt()
    const val PANEL = 0xFF1E1B29.toInt()

    val gradient = intArrayOf(BERRY1, BERRY2, BERRY3, BERRY4)
    val gradientStops = floatArrayOf(0f, 0.34f, 0.68f, 1f)

    fun withAlpha(color: Int, alpha: Float): Int =
        Color.argb((alpha * 255).toInt().coerceIn(0, 255), Color.red(color), Color.green(color), Color.blue(color))

    // Compose versions.
    val berry1 = ComposeColor(BERRY1)
    val berry2 = ComposeColor(BERRY2)
    val berry3 = ComposeColor(BERRY3)
    val berry4 = ComposeColor(BERRY4)
    val nose = ComposeColor(NOSE)
    val ink = ComposeColor(INK)
    val inkSoft = ComposeColor(INK_SOFT)
    val panel = ComposeColor(PANEL)
    val green = ComposeColor(0xFF5BE49B)
    val red = ComposeColor(0xFFE5547A)
    val listenBlue = ComposeColor(0xFF4F8BFF)

    /** The blueberry gradient at 150°, like the design. */
    fun brush(width: Float, height: Float): Brush = Brush.linearGradient(
        colorStops = arrayOf(0f to berry1, 0.34f to berry2, 0.68f to berry3, 1f to berry4),
        start = Offset(0.25f * width, 0.067f * height),
        end = Offset(0.75f * width, 0.933f * height),
    )

    val brush: Brush = Brush.linearGradient(
        colorStops = arrayOf(0f to berry1, 0.34f to berry2, 0.68f to berry3, 1f to berry4),
    )
}
