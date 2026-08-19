import type { Review, ReviewPage } from "../types.js";
import { PlaceError } from "./errors.js";
import { getPlaceFixtureById, loadPlaceFixtures } from "./place.js";

export const REVIEWS_PAGE_SIZE = 5;

type ReviewSeed = {
  id?: string | null;
  author?: string | null;
  stars: number;
  text: string;
  createdAt?: string | null;
  language?: string | null;
};

const SPECIAL_REVIEWS: Record<string, ReviewSeed[]> = {
  "franklin-bbq-austin": [
    {
      id: "rev_franklin_1",
      author: "Maya T.",
      stars: 5,
      text: "Brisket was worth the wait. Get there early.",
      createdAt: "2026-03-12T15:02:00.000Z",
      language: "en",
    },
    {
      id: "rev_franklin_2",
      author: "Chris L.",
      stars: 4,
      text: "Line moved. Sides were fine; the beef is the point.",
      createdAt: "2026-02-01T18:40:00.000Z",
      language: "en",
    },
    {
      id: "rev_franklin_3",
      author: "Priya S.",
      stars: 5,
      text: "Public snapshot: sold out of ribs by the time we sat.",
      createdAt: "2026-01-20T21:11:00.000Z",
      language: "en",
    },
    {
      id: "rev_franklin_4",
      author: null,
      stars: 3,
      text: "Great meat, long morning. Bring a chair.",
      createdAt: "2025-11-08T14:00:00.000Z",
      language: "en",
    },
    {
      id: "rev_franklin_5",
      author: "Diego R.",
      stars: 5,
      text: "Turkey and sausage packed for the flight home.",
      createdAt: "2025-10-02T16:33:00.000Z",
      language: "en",
    },
    {
      id: "rev_franklin_6",
      author: "Hannah K.",
      stars: 4,
      text: "Second page: still thinking about the sauce.",
      createdAt: "2025-08-19T12:05:00.000Z",
      language: "en",
    },
    {
      id: "rev_franklin_7",
      author: "Owen B.",
      stars: 5,
      text: "Anniversary lunch. They called our name right at open.",
      createdAt: "2025-07-04T17:22:00.000Z",
      language: "en",
    },
  ],
  "blue-bottle-mint-sf": [],
  "dishoom-covent-garden": [
    {
      id: "rev_dishoom_1",
      author: "Amelia W.",
      stars: 5,
      text: "Black daal and a bacon naan. Come before the queue.",
      createdAt: "2026-04-03T19:10:00.000Z",
      language: "en",
    },
    {
      id: "rev_dishoom_2",
      author: "Julien P.",
      stars: 4,
      text: "Salle bruyante mais le chai vaut le détour.",
      createdAt: "2026-02-14T20:00:00.000Z",
      language: "fr",
    },
    {
      id: "rev_dishoom_3",
      author: "Samira H.",
      stars: 5,
      text: "House chai and the permit room feel. Book if you can.",
      createdAt: "2025-12-22T13:45:00.000Z",
      language: "en",
    },
  ],
  "joe-coffee-west-village": [
    {
      id: null,
      author: null,
      stars: 4,
      text: "Window seat, solid drip. Card only when we went.",
      createdAt: null,
      language: null,
    },
  ],
};

type Catalog = {
  bySlug: Map<string, Review[]>;
};

let cachedCatalog: Catalog | undefined;

function cloneReview(review: Review): Review {
  return {
    id: review.id,
    author: review.author,
    stars: review.stars,
    text: review.text,
    createdAt: review.createdAt,
    language: review.language,
  };
}

export function sanitizeReview(raw: ReviewSeed, label: string): Review {
  const text = raw.text.trim();
  if (text === "") {
    throw new Error(`${label} review text must be non-empty`);
  }
  if (!Number.isInteger(raw.stars) || raw.stars < 1 || raw.stars > 5) {
    throw new Error(`${label} stars must be an integer 1-5`);
  }
  return {
    id: raw.id === undefined ? null : raw.id,
    author: raw.author === undefined ? null : raw.author,
    stars: raw.stars,
    text,
    createdAt: raw.createdAt === undefined ? null : raw.createdAt,
    language: raw.language === undefined ? null : raw.language,
  };
}

function stockReviews(slug: string, name: string): Review[] {
  return [
    sanitizeReview(
      {
        id: `rev_${slug}_1`,
        author: "Alex P.",
        stars: 5,
        text: `Public snapshot: ${name} is worth the stop.`,
        createdAt: "2026-01-15T12:00:00.000Z",
        language: "en",
      },
      slug,
    ),
    sanitizeReview(
      {
        id: `rev_${slug}_2`,
        author: "Riley M.",
        stars: 4,
        text: `Went to ${name} on a weekday. Service was fine.`,
        createdAt: "2025-09-30T16:20:00.000Z",
        language: "en",
      },
      slug,
    ),
  ];
}

function reviewsForSlug(slug: string, name: string): Review[] {
  if (Object.hasOwn(SPECIAL_REVIEWS, slug)) {
    return SPECIAL_REVIEWS[slug]!.map((row, index) =>
      sanitizeReview(row, `${slug}[${index}]`),
    );
  }
  return stockReviews(slug, name);
}

function loadCatalog(): Catalog {
  if (cachedCatalog !== undefined) {
    return cachedCatalog;
  }
  const bySlug = new Map<string, Review[]>();
  for (const fixture of loadPlaceFixtures()) {
    bySlug.set(fixture.slug, reviewsForSlug(fixture.slug, fixture.name));
  }
  cachedCatalog = { bySlug };
  return cachedCatalog;
}

export function loadReviewFixtures(): Map<string, Review[]> {
  return new Map(
    [...loadCatalog().bySlug.entries()].map(([slug, reviews]) => [
      slug,
      reviews.map(cloneReview),
    ]),
  );
}

/** Missing or empty → page 1. Otherwise a positive integer. */
export function parseReviewPage(value: string | number | undefined): number | null {
  if (value === undefined || value === "") {
    return 1;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) {
      return null;
    }
    return value;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const page = Number(value);
  if (!Number.isSafeInteger(page)) {
    return null;
  }
  return page;
}

export function parseReviewLang(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function getReviewPage(
  placeId: string,
  query: { page?: string | number; lang?: string } = {},
): ReviewPage {
  const fixture = getPlaceFixtureById(placeId);
  const page = parseReviewPage(query.page);
  if (page === null) {
    throw new PlaceError("invalid_request", "page must be a positive integer.");
  }
  const language = parseReviewLang(query.lang);
  const all = loadCatalog().bySlug.get(fixture.slug) ?? [];
  const filtered =
    language === null ? all : all.filter((review) => review.language === language);
  const start = (page - 1) * REVIEWS_PAGE_SIZE;
  const slice = filtered.slice(start, start + REVIEWS_PAGE_SIZE);
  return {
    page,
    hasMore: start + slice.length < filtered.length,
    language,
    reviews: slice.map(cloneReview),
  };
}
