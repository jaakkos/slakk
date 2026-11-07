pub const R: f64 = 6_378_137.0;

/// lonlat as [lon, lat] → mercator [x, y]
pub fn lonlat_to_mercator(lon: f64, lat: f64) -> (f64, f64) {
    let x = R * lon.to_radians();
    let y = R * (std::f64::consts::FRAC_PI_4 + lat.to_radians() / 2.0).tan().ln();
    (x, y)
}

pub fn mercator_to_lonlat(x: f64, y: f64) -> (f64, f64) {
    let lon = (x / R).to_degrees();
    let lat = (2.0 * (y / R).exp().atan() - std::f64::consts::FRAC_PI_2).to_degrees();
    (lon, lat)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let (x, y) = lonlat_to_mercator(18.95, 69.65);
        let (lon, lat) = mercator_to_lonlat(x, y);
        assert!((lon - 18.95).abs() < 1e-9);
        assert!((lat - 69.65).abs() < 1e-9);
    }
}
