//! UTC times as ISO 8601 text, from Unix seconds.

/// A day of the proleptic Gregorian calendar.
struct CivilDate {
    year: u64,
    month: u64,
    day: u64,
}

/// `2026-11-15T11:42:10Z`.
pub fn utc_time(unix_seconds: u64) -> String {
    let (days, rest) = (unix_seconds / 86_400, unix_seconds % 86_400);
    let CivilDate { year, month, day } = civil_date(days);

    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3_600, rest % 3_600 / 60, rest % 60)
}

/// Howard Hinnant's `civil_from_days`, for days since 1970-01-01.
fn civil_date(days: u64) -> CivilDate {
    let shifted = days.saturating_add(719_468);
    let era = shifted / 146_097;
    let day_of_era = shifted.saturating_sub(era.saturating_mul(146_097));
    let year_of_era = day_of_era
        .saturating_sub(day_of_era / 1_460)
        .saturating_add(day_of_era / 36_524)
        .saturating_sub(day_of_era / 146_096)
        / 365;
    let year_days = year_of_era.saturating_mul(365).saturating_add(year_of_era / 4).saturating_sub(year_of_era / 100);
    let day_of_year = day_of_era.saturating_sub(year_days);
    let month_index = day_of_year.saturating_mul(5).saturating_add(2) / 153;
    let day = day_of_year.saturating_sub(month_index.saturating_mul(153).saturating_add(2) / 5).saturating_add(1);
    let month = if month_index < 10 { month_index.saturating_add(3) } else { month_index.saturating_sub(9) };
    let year = year_of_era.saturating_add(era.saturating_mul(400)).saturating_add(u64::from(month <= 2));

    CivilDate { year, month, day }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_utc_time() {
        assert_eq!(utc_time(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_time(1_794_686_400), "2026-11-14T20:00:00Z");
        assert_eq!(utc_time(951_782_400), "2000-02-29T00:00:00Z");
    }
}
