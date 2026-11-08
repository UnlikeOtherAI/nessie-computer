//! The words the notification-area menu and its toasts use, in the seven
//! languages Nessie Computer ships: en-GB, en-US, cs, de, es, fr and it.
//!
//! The window's console has its own translations; these are the strings only
//! this process shows. They use the same vocabulary (team, Pause, Resume,
//! Needs you, Allow once / Always allow / Don't allow). The language is the
//! person's Windows display language, resolved once: an exact match, then the
//! language alone, then British English.

use std::sync::OnceLock;

pub use crate::words_tables::Words;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    EnGb,
    EnUs,
    Cs,
    De,
    Es,
    Fr,
    It,
}

/// Picks the supported language for a BCP 47 tag such as `cs-CZ` or `en_US`.
pub fn resolve(tag: &str) -> Locale {
    let tag = tag.trim().replace('_', "-").to_ascii_lowercase();
    if tag == "en-us" {
        return Locale::EnUs;
    }
    match tag.split('-').next().unwrap_or("") {
        "cs" => Locale::Cs,
        "de" => Locale::De,
        "es" => Locale::Es,
        "fr" => Locale::Fr,
        "it" => Locale::It,
        _ => Locale::EnGb,
    }
}

/// Which plural form a count takes. Czech has a separate form for 2–4;
/// French counts 0 and 1 as singular.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plural {
    One,
    Few,
    Other,
}

pub fn plural(locale: Locale, count: usize) -> Plural {
    match locale {
        Locale::Cs if count == 1 => Plural::One,
        Locale::Cs if (2..=4).contains(&count) => Plural::Few,
        Locale::Fr if count <= 1 => Plural::One,
        _ if count == 1 => Plural::One,
        _ => Plural::Other,
    }
}

/// A counted phrase: one form per plural category the languages use.
#[derive(Debug, Clone, Copy)]
pub struct Counted {
    pub one: &'static str,
    pub few: &'static str,
    pub other: &'static str,
}

impl Counted {
    pub fn pick(&self, locale: Locale, count: usize) -> String {
        let template = match plural(locale, count) {
            Plural::One => self.one,
            Plural::Few => self.few,
            Plural::Other => self.other,
        };
        fill(template, &[("n", &count.to_string())])
    }
}

/// Replaces `{name}` placeholders. A value is inserted as text; it is never
/// read as a further template.
pub fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) => {
                let name = &after[..close];
                match values.iter().find(|(key, _)| *key == name) {
                    Some((_, value)) => out.push_str(value),
                    None => out.push_str(&rest[open..open + close + 2]),
                }
                rest = &after[close + 1..];
            }
            None => {
                out.push_str(&rest[open..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

pub fn table(locale: Locale) -> &'static Words {
    use crate::words_tables::{CS, DE, EN_GB, EN_US, ES, FR, IT};
    match locale {
        Locale::EnGb => &EN_GB,
        Locale::EnUs => &EN_US,
        Locale::Cs => &CS,
        Locale::De => &DE,
        Locale::Es => &ES,
        Locale::Fr => &FR,
        Locale::It => &IT,
    }
}

#[cfg(windows)]
fn display_language() -> Option<String> {
    use windows_sys::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
    let (mut count, mut size) = (0u32, 0u32);
    if unsafe { GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, std::ptr::null_mut(), &mut size) } == 0
        || size == 0
    {
        return None;
    }
    let mut buffer = vec![0u16; size as usize];
    if unsafe { GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, buffer.as_mut_ptr(), &mut size) } == 0 {
        return None;
    }
    let first: Vec<u16> = buffer.into_iter().take_while(|unit| *unit != 0).collect();
    String::from_utf16(&first).ok().filter(|tag| !tag.is_empty())
}

#[cfg(not(windows))]
fn display_language() -> Option<String> {
    std::env::var("LANG").ok().map(|value| value.split('.').next().unwrap_or("").to_owned())
}

/// This person's language, resolved once for the life of the process.
pub fn locale() -> Locale {
    static LOCALE: OnceLock<Locale> = OnceLock::new();
    *LOCALE.get_or_init(|| display_language().map_or(Locale::EnGb, |tag| resolve(&tag)))
}

pub fn words() -> &'static Words {
    table(locale())
}

#[cfg(test)]
mod tests {
    use super::{fill, plural, resolve, table, Locale, Plural};

    #[test]
    fn a_windows_display_language_resolves_to_a_shipped_one() {
        assert_eq!(resolve("en-US"), Locale::EnUs);
        assert_eq!(resolve("en-GB"), Locale::EnGb);
        assert_eq!(resolve("en-AU"), Locale::EnGb);
        assert_eq!(resolve("cs-CZ"), Locale::Cs);
        assert_eq!(resolve("de-AT"), Locale::De);
        assert_eq!(resolve("es_MX"), Locale::Es);
        assert_eq!(resolve("fr-CA"), Locale::Fr);
        assert_eq!(resolve("it-IT"), Locale::It);
        assert_eq!(resolve("ja-JP"), Locale::EnGb);
        assert_eq!(resolve(""), Locale::EnGb);
    }

    #[test]
    fn counts_take_each_languages_plural_form() {
        assert_eq!(plural(Locale::Cs, 1), Plural::One);
        assert_eq!(plural(Locale::Cs, 3), Plural::Few);
        assert_eq!(plural(Locale::Cs, 5), Plural::Other);
        assert_eq!(plural(Locale::Fr, 0), Plural::One);
        assert_eq!(plural(Locale::De, 0), Plural::Other);
        assert_eq!(table(Locale::Cs).working.pick(Locale::Cs, 2), "Pracuje pro 2 týmy");
        assert_eq!(table(Locale::Cs).working.pick(Locale::Cs, 7), "Pracuje pro 7 týmů");
        assert_eq!(table(Locale::EnGb).working.pick(Locale::EnGb, 1), "Working for 1 team");
        assert_eq!(table(Locale::EnUs).working.pick(Locale::EnUs, 2), "Working for 2 teams");
    }

    #[test]
    fn a_placeholder_takes_text_and_never_a_second_template() {
        assert_eq!(fill("Always allow {program}", &[("program", "{team}")]), "Always allow {team}");
        assert_eq!(fill("{agent} wants to run {program}", &[("agent", "Builder"), ("program", "python")]),
            "Builder wants to run python");
        assert_eq!(fill("Unclosed {brace", &[]), "Unclosed {brace");
        assert_eq!(fill("Unknown {name}", &[]), "Unknown {name}");
    }

    /// Every language says every string, and every template keeps the
    /// placeholders the English one has.
    #[test]
    fn every_language_carries_every_phrase_with_its_placeholders() {
        let all = [Locale::EnGb, Locale::EnUs, Locale::Cs, Locale::De, Locale::Es, Locale::Fr, Locale::It];
        let english = table(Locale::EnGb).all();
        for locale in all {
            let phrases = table(locale).all();
            assert_eq!(phrases.len(), english.len());
            for ((name, phrase), (_, reference)) in phrases.iter().zip(&english) {
                assert!(!phrase.trim().is_empty(), "{locale:?} {name} is empty");
                for placeholder in ["{n}", "{team}", "{program}", "{agent}"] {
                    assert_eq!(phrase.contains(placeholder), reference.contains(placeholder),
                        "{locale:?} {name} must keep {placeholder}");
                }
            }
        }
    }
}
