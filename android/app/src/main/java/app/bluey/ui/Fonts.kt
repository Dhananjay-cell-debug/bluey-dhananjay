package app.bluey.ui

import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import app.bluey.R

/** The design's fonts: Fredoka for his voice and titles, IBM Plex for everything else (variable fonts, set by weight). */
@OptIn(ExperimentalTextApi::class)
object Fonts {
    val fredoka = FontFamily(Font(R.font.fredoka, FontWeight.Bold, variationSettings = FontVariation.Settings(FontVariation.weight(700))))
    val plexSans = FontFamily(
        Font(R.font.plex_sans, FontWeight.Normal, variationSettings = FontVariation.Settings(FontVariation.weight(400))),
        Font(R.font.plex_sans, FontWeight.SemiBold, variationSettings = FontVariation.Settings(FontVariation.weight(600))),
    )
    val plexMono = FontFamily(Font(R.font.plex_mono, FontWeight.Normal))
}
