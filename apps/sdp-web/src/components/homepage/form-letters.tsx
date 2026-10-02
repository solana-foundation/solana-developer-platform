import styles from "./form-heading.module.css";

type FormLettersProps = {
  text: string;
  /** Index of this run's first letter within the heading, so the stagger runs on across runs. */
  start?: number;
  /** Milliseconds between one letter and the next. */
  stepMs: number;
};

type Word = { text: string; offset: number; firstLetter: number };

/** Words with their character offset (a stable key) and the index of their first letter. */
function splitWords(text: string, start: number): Word[] {
  const words: Word[] = [];
  let letter = start;
  for (const match of text.matchAll(/\S+/g)) {
    words.push({ text: match[0], offset: match.index, firstLetter: letter });
    letter += [...match[0]].length;
  }
  return words;
}

/**
 * Splits text into letters for the headline "form-in": each letter rises as an
 * outline, blurs pink, then sets as ink, a little after the one before it.
 * Words stay whole so a line never breaks inside one. The split copy is for
 * the eye only; the heading carries the real text for assistive technology.
 */
export function FormLetters({ text, start = 0, stepMs }: FormLettersProps) {
  return splitWords(text, start).map((word, wordIndex) => (
    <span key={word.offset}>
      {wordIndex > 0 ? " " : null}
      <span className={styles.word}>
        {[...word.text].map((letter, letterIndex) => {
          const position = word.firstLetter + letterIndex;
          return (
            <span
              key={position}
              data-letter=""
              className={styles.letter}
              style={{ transitionDelay: `${position * stepMs}ms` }}
            >
              {letter}
            </span>
          );
        })}
      </span>
    </span>
  ));
}

/** How many letters FormLetters draws for `text`, to start the next run where this one ends. */
export function letterCount(text: string): number {
  return [...text.replace(/\s+/g, "")].length;
}
