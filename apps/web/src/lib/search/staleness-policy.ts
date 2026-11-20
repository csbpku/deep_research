/** One place for how quickly a judgement loses authority. */
export const STALENESS_THRESHOLDS = {
  /** Past this many days a judgement is merely aged. */
  aged: 30,
  /** Past this many days it is treated as abandoned. */
  abandoned: 180,
} as const;

export const SEARCH_STALENESS_BOOST = {
  fresh: 3,
  aged: 1,
  abandoned: 0,
} as const;
