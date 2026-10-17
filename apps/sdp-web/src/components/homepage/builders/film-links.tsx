"use client";

import Image from "next/image";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import styles from "./builders.module.css";
import { FILMS, filmStill, filmUrl, SERIES_URL } from "./films";

/**
 * The films as real links, so the section is never canvas-only. Beside the ring they are hidden
 * until a key reaches them, then show over the stage; without the ring they are the section's
 * grid of stills.
 */
export function FilmLinks({ withStills }: { withStills: boolean }) {
  const t = useTranslations();
  return (
    <ul
      className={cn(withStills ? styles.grid : styles.keyList)}
      aria-label={t("Homepage.builders.films")}
    >
      {FILMS.map((film) => (
        <li key={film.id}>
          <a
            href={filmUrl(film.id)}
            target="_blank"
            rel="noreferrer"
            aria-label={t("Homepage.builders.film", { name: film.name })}
            className={styles.film}
          >
            {withStills ? (
              <Image
                src={filmStill(film.id)}
                alt=""
                width={1280}
                height={720}
                sizes="(max-width: 700px) 45vw, 300px"
                className={styles.still}
              />
            ) : null}
            <span>{film.name}</span>
          </a>
        </li>
      ))}
      {withStills ? null : (
        <li>
          <a
            href={SERIES_URL}
            target="_blank"
            rel="noreferrer"
            aria-label={t("Homepage.builders.seriesLabel")}
            className={styles.film}
          >
            {t("Homepage.builders.series")}
          </a>
        </li>
      )}
    </ul>
  );
}
