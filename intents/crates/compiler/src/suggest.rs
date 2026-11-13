//! "Did you mean" suggestions.

/// The candidate nearest to `word`, when it is near enough to be a typo: at most a third of the
/// word's length in edits, and at least one.
pub fn closest<'c>(word: &str, candidates: impl Iterator<Item = &'c str>) -> Option<&'c str> {
    let limit = (word.chars().count() / 3).max(1);

    candidates
        .map(|candidate| (distance(word, candidate), candidate))
        .filter(|(edits, _)| *edits <= limit)
        .min_by_key(|(edits, _)| *edits)
        .map(|(_, candidate)| candidate)
}

/// Optimal string alignment distance, by characters: Levenshtein distance in which swapping two
/// neighbors costs one edit, because a swap is the most common typo.
fn distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut rows = vec![vec![0usize; b.len().saturating_add(1)]; a.len().saturating_add(1)];

    rows.iter_mut().enumerate().for_each(|(i, row)| {
        row.iter_mut().enumerate().for_each(|(j, cell)| {
            *cell = if i == 0 {
                j
            } else if j == 0 {
                i
            } else {
                0
            };
        })
    });

    (1..=a.len()).for_each(|i| {
        (1..=b.len()).for_each(|j| {
            let cell = |i: usize, j: usize| rows.get(i).and_then(|row| row.get(j)).copied().unwrap_or(usize::MAX);
            let a_char = a.get(i.saturating_sub(1));
            let b_char = b.get(j.saturating_sub(1));
            let cost = usize::from(a_char != b_char);

            let mut best = cell(i.saturating_sub(1), j)
                .saturating_add(1)
                .min(cell(i, j.saturating_sub(1)).saturating_add(1))
                .min(cell(i.saturating_sub(1), j.saturating_sub(1)).saturating_add(cost));

            let swapped =
                i > 1 && j > 1 && a_char == b.get(j.saturating_sub(2)) && a.get(i.saturating_sub(2)) == b_char;
            if swapped {
                best = best.min(cell(i.saturating_sub(2), j.saturating_sub(2)).saturating_add(1));
            }

            if let Some(slot) = rows.get_mut(i).and_then(|row| row.get_mut(j)) {
                *slot = best;
            }
        });
    });

    rows.last().and_then(|row| row.last()).copied().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggests_near_words_only() {
        let keys = ["postConditions", "inputs", "outputs"];

        assert_eq!(closest("postconditions", keys.into_iter()), Some("postConditions"));
        assert_eq!(closest("imputs", keys.into_iter()), Some("inputs"));
        assert_eq!(closest("recipe", keys.into_iter()), None);
    }

    #[test]
    fn counts_edits() {
        assert_eq!(distance("kitten", "sitting"), 3);
        assert_eq!(distance("", "abc"), 3);
        assert_eq!(distance("mnit", "mint"), 1);
    }
}
