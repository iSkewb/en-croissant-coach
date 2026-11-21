import { atomWithStorage } from "jotai/utils";
import { DEFAULT_LESSON_SETTINGS, type LessonSettings } from "./lessonPlan";

export type LessonPrefs = LessonSettings & {
    /** Open the app on Today's lesson instead of the board. */
    openOnStart: boolean;
};

export const lessonPrefsAtom = atomWithStorage<LessonPrefs>("coach-lesson-prefs", {
    ...DEFAULT_LESSON_SETTINGS,
    openOnStart: true,
});

/** Minutes to add to UTC to get local time (what the backend's date math expects). */
export const tzOffsetMinutes = () => -new Date().getTimezoneOffset();

export const COACH_SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";
