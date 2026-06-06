//! Image metadata extraction.
//!
//! PROPOSAL.md line 88 lists "Images (with metadata extraction)" as
//! a supported file type. For JPEG / PNG / TIFF / WebP files this
//! module extracts:
//!
//! - Image format and pixel dimensions via the [`image`] crate's
//!   header decoder (no full-image decode — we only need the
//!   metadata block).
//! - EXIF tags (camera make/model, ISO, exposure time, capture date,
//!   GPS coordinates, …) via the [`exif`] crate (the `kamadak-exif`
//!   package).
//!
//! The extracted metadata is serialised into a human-readable text
//! representation that the chunker can split like any other source.
//! This means a photo file becomes searchable by its camera make,
//! model, lens, date, and (when present) GPS location — useful when
//! a user asks "which photos were taken on the trip to Iceland?".

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use tessera_core::error::{Error, Result};

/// Extension-level routing for image files. Returns the lowercased
/// extension when the file is one Tessera knows how to extract
/// metadata from, or `None` otherwise.
pub fn image_extension(path: &Path) -> Option<String> {
    let ext = path.extension().and_then(|e| e.to_str())?.to_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "tif" | "tiff" | "webp" => Some(ext),
        _ => None,
    }
}

/// Returns `true` for the raster image extensions this module can
/// extract metadata from.
pub fn is_image_extension(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "tif" | "tiff" | "webp"
    )
}

/// Extract a textual representation of an image's metadata. The
/// output is line-oriented `key: value` pairs which the chunker
/// embeds verbatim. Returns
/// [`Error::Extraction`] when the file cannot be opened or parsed.
pub fn extract_image_metadata(path: &Path) -> Result<String> {
    let ext = image_extension(path).ok_or_else(|| Error::Extraction {
        path: path.display().to_string(),
        message: "not an image file".to_string(),
    })?;
    let metadata = read_metadata(path).map_err(|e| Error::Extraction {
        path: path.display().to_string(),
        message: e,
    })?;
    let mut lines: Vec<String> = Vec::with_capacity(8 + metadata.exif.len());
    lines.push(format!("File: {}", path.display()));
    lines.push(format!("Format: {ext}"));
    if let Some((w, h)) = metadata.dimensions {
        lines.push(format!("Dimensions: {w}x{h}"));
    }
    for (tag, value) in &metadata.exif {
        lines.push(format!("{tag}: {value}"));
    }
    if let Some(gps) = metadata.gps_summary() {
        lines.push(format!("GPS: {gps}"));
    }
    Ok(lines.join("\n"))
}

#[derive(Debug, Default)]
struct ImageMetadata {
    dimensions: Option<(u32, u32)>,
    /// Selected EXIF tags in (display-name, formatted-value) form.
    /// We deliberately keep this short and human-readable rather
    /// than dumping every tag.
    exif: Vec<(String, String)>,
    gps_lat: Option<f64>,
    gps_lon: Option<f64>,
}

impl ImageMetadata {
    fn gps_summary(&self) -> Option<String> {
        match (self.gps_lat, self.gps_lon) {
            (Some(lat), Some(lon)) => Some(format!("{lat:.6}, {lon:.6}")),
            _ => None,
        }
    }
}

fn read_metadata(path: &Path) -> std::result::Result<ImageMetadata, String> {
    let mut metadata = ImageMetadata::default();

    // Pixel dimensions via the image crate's lightweight header
    // probe — does NOT decode the pixel data.
    if let Ok(reader) =
        image::ImageReader::open(path).and_then(image::ImageReader::with_guessed_format)
    {
        if let Ok(dim) = reader.into_dimensions() {
            metadata.dimensions = Some(dim);
        }
    }

    // EXIF — only attempt for formats that can carry EXIF
    // (JPEG / TIFF / WebP). PNGs typically don't have EXIF, but
    // some do (extension chunk); attempting is cheap.
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut bufreader = BufReader::new(file);
    let exif_reader = exif::Reader::new();
    if let Ok(exif) = exif_reader.read_from_container(&mut bufreader) {
        // Curated set of tags. We treat unrecognised tags as
        // uninteresting; users searching for "Canon" will hit the
        // `Make` line below regardless.
        const TAGS: &[(exif::Tag, &str)] = &[
            (exif::Tag::Make, "Camera Make"),
            (exif::Tag::Model, "Camera Model"),
            (exif::Tag::LensModel, "Lens"),
            (exif::Tag::DateTimeOriginal, "Captured"),
            (exif::Tag::DateTime, "Modified"),
            (exif::Tag::Software, "Software"),
            (exif::Tag::ExposureTime, "Exposure"),
            (exif::Tag::FNumber, "Aperture"),
            (exif::Tag::ISOSpeed, "ISO"),
            (exif::Tag::PhotographicSensitivity, "ISO"),
            (exif::Tag::FocalLength, "Focal Length"),
            (exif::Tag::ImageDescription, "Description"),
            (exif::Tag::Artist, "Artist"),
            (exif::Tag::Copyright, "Copyright"),
            (exif::Tag::Orientation, "Orientation"),
            (exif::Tag::PixelXDimension, "Width"),
            (exif::Tag::PixelYDimension, "Height"),
        ];
        for (tag, label) in TAGS {
            if let Some(field) = exif.get_field(*tag, exif::In::PRIMARY) {
                let value = field.display_value().to_string();
                let value = value.trim_matches('"').to_string();
                if !value.is_empty() && value != "0" && !already_recorded(&metadata.exif, label) {
                    metadata.exif.push(((*label).to_string(), value));
                }
            }
        }

        // GPS — decode the rational degree/minute/second fields
        // into a single signed decimal pair.
        metadata.gps_lat = decode_gps(&exif, exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef);
        metadata.gps_lon = decode_gps(&exif, exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef);
    }

    Ok(metadata)
}

fn already_recorded(entries: &[(String, String)], label: &str) -> bool {
    entries.iter().any(|(k, _)| k == label)
}

fn decode_gps(exif: &exif::Exif, tag: exif::Tag, ref_tag: exif::Tag) -> Option<f64> {
    let coord = exif.get_field(tag, exif::In::PRIMARY)?;
    let direction = exif.get_field(ref_tag, exif::In::PRIMARY)?;
    let exif::Value::Rational(rats) = &coord.value else {
        return None;
    };
    if rats.len() < 3 {
        return None;
    }
    let deg = rats[0].to_f64();
    let min = rats[1].to_f64();
    let sec = rats[2].to_f64();
    let decimal = deg + (min / 60.0) + (sec / 3600.0);
    let sign = match &direction.value {
        exif::Value::Ascii(parts) if !parts.is_empty() => match parts[0].first().copied() {
            Some(b'S' | b'W') => -1.0,
            _ => 1.0,
        },
        _ => 1.0,
    };
    Some(decimal * sign)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn detects_supported_extensions() {
        assert!(is_image_extension("jpg"));
        assert!(is_image_extension("JPEG"));
        assert!(is_image_extension("png"));
        assert!(is_image_extension("tiff"));
        assert!(is_image_extension("webp"));
        assert!(!is_image_extension("gif"));
        assert!(!is_image_extension("txt"));
    }

    #[test]
    fn image_extension_returns_lowercase() {
        assert_eq!(
            image_extension(Path::new("photo.JPG")),
            Some("jpg".to_string())
        );
        assert_eq!(image_extension(Path::new("note.md")), None);
    }

    fn write_tiny_png(path: &Path) {
        // Generate a 2x2 white PNG via the image crate.
        let img = image::RgbaImage::from_fn(2, 2, |_, _| image::Rgba([255, 255, 255, 255]));
        img.save_with_format(path, image::ImageFormat::Png).unwrap();
    }

    fn write_tiny_jpeg(path: &Path) {
        let img = image::RgbImage::from_fn(4, 3, |_, _| image::Rgb([128, 128, 128]));
        img.save_with_format(path, image::ImageFormat::Jpeg)
            .unwrap();
    }

    #[test]
    fn extracts_dimensions_for_png() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tiny.png");
        write_tiny_png(&path);
        let text = extract_image_metadata(&path).unwrap();
        assert!(text.contains("Format: png"));
        assert!(text.contains("Dimensions: 2x2"));
    }

    #[test]
    fn extracts_dimensions_for_jpeg_without_exif() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tiny.jpg");
        write_tiny_jpeg(&path);
        let text = extract_image_metadata(&path).unwrap();
        assert!(text.contains("Format: jpg"));
        assert!(text.contains("Dimensions: 4x3"));
    }

    #[test]
    fn non_image_extension_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.bin");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"not an image").unwrap();
        let result = extract_image_metadata(&path);
        assert!(result.is_err());
    }

    #[test]
    fn corrupt_jpeg_returns_partial_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.jpg");
        std::fs::write(&path, b"not really a jpeg").unwrap();
        // The metadata extractor must not panic and must report
        // at least the format/file fields even when EXIF and pixel
        // probe both fail.
        let text = extract_image_metadata(&path).unwrap();
        assert!(text.contains("Format: jpg"));
        assert!(text.contains("broken.jpg"));
    }
}
