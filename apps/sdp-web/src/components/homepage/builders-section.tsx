import { cn } from "@sdp/ui/cn";
import Image from "next/image";
import { getTranslations } from "@/i18n/server";
import styles from "./builders/builders.module.css";
import { FILMS, filmStill, filmUrl, SERIES_URL } from "./builders/films";
import { FormHeadline } from "./form-headline";
import shared from "./homepage.module.css";
import { Rise } from "./rise";

function YouTubeMark() {
  return (
    <svg className={styles.ytm} viewBox="0 0 28 20" aria-hidden="true">
      <path
        fill="#FF0000"
        d="M27.4 3.1A3.5 3.5 0 0 0 24.9.6C22.7 0 14 0 14 0S5.3 0 3.1.6A3.5 3.5 0 0 0 .6 3.1C0 5.3 0 10 0 10s0 4.7.6 6.9a3.5 3.5 0 0 0 2.5 2.5C5.3 20 14 20 14 20s8.7 0 10.9-.6a3.5 3.5 0 0 0 2.5-2.5C28 14.7 28 10 28 10s0-4.7-.6-6.9Z"
      />
      <path fill="#fff" d="M11.2 14.3 18.5 10l-7.3-4.3v8.6Z" />
    </svg>
  );
}

/**
 * Meet the builders, still: the sixteen films as a grid of faces beside the words. A dark panel
 * rounded at the top only, so the close runs on from it as one dark block.
 */
export async function BuildersSection() {
  const t = await getTranslations();
  return (
    <section
      id="builders"
      data-ground="panel"
      aria-label={t("Homepage.builders.label")}
      className={cn(shared.panel, styles.section)}
    >
      <div className={cn(shared.wrap, styles.layout)}>
        <Rise index={0}>
          <ul className={styles.faces} aria-label={t("Homepage.builders.films")}>
            {FILMS.map((film) => (
              <li key={film.id}>
                <a
                  href={filmUrl(film.id)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t("Homepage.builders.film", { name: film.name })}
                  className={styles.face}
                >
                  <Image
                    src={filmStill(film.id)}
                    alt=""
                    width={480}
                    height={480}
                    sizes="(max-width: 900px) 25vw, 200px"
                  />
                  <span>{film.name}</span>
                </a>
              </li>
            ))}
          </ul>
        </Rise>
        <Rise index={1} className={styles.text}>
          <FormHeadline
            as="h2"
            className={styles.title}
            parts={[t("Homepage.builders.intro.title")]}
          />
          <p className={styles.body}>{t("Homepage.builders.intro.body")}</p>
          <div className={styles.cta}>
            <a
              className={cn(shared.btn, shared.btnLine, styles.series)}
              href={SERIES_URL}
              target="_blank"
              rel="noreferrer"
              aria-label={t("Homepage.builders.seriesLabel")}
            >
              <YouTubeMark />
              {t("Homepage.builders.series")}
            </a>
          </div>
        </Rise>
      </div>
    </section>
  );
}
