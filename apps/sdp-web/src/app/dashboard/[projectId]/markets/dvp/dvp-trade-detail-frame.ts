/**
 * The trade detail page's frame: the panel padding that steps with the
 * viewport, and the centered column the workspace, its loading skeleton and
 * its load-error state all draw inside. One decision, three consumers, so the
 * page's edges cannot move between loading, content and failure.
 */
export const DVP_TRADE_DETAIL_FRAME_CLASS = "px-4 pt-6 pb-8 md:px-8 xl:px-16";

/** The centered column inside the frame; callers add their own flow classes. */
export const DVP_TRADE_DETAIL_COLUMN_CLASS = "mx-auto w-full max-w-[63rem]";
