/**
 * Fuzzy matching of a free-form answer typed on the M5Stack Core S3 onto the
 * options Cline offered for a pending question.
 *
 * The Core S3 only has a touch keyboard, so answers arrive as loose text
 * ("oui", "2", "Yes: go ahead") while Cline's options are model-authored
 * labels ("Yes", "Reject", "Refactor the parser"). Everything here is a pure
 * function of those two strings, so the behaviour is unit-testable without a
 * device.
 *
 * Scoring ladder, per option: exact normalised equality, whole-label
 * containment in the answer, answer-as-subset-of-label, then Jaro-Winkler
 * similarity capped below the containment scores so a real containment always
 * outranks a typo correction. Two shortcuts run first: a bare ordinal ("2") or
 * letter ("b") resolves to the option at that position, and yes/no-ish words
 * resolve to the first/second option of a two-option question (the UI
 * convention is primary first - Approve before Reject - see BUTTON_CONFIGS in
 * the webview).
 *
 * A best score is only accepted when it clears `minScore` AND leads the
 * runner-up by `distinctMargin`, so an answer sitting between two similar
 * labels comes back as ambiguous instead of silently picking one.
 */

export type OptionMatchRejection = "empty_answer" | "no_options" | "below_threshold" | "ambiguous"

export interface OptionMatchOptions {
	/** Lowest score accepted as a match. Default 0.55. */
	minScore?: number
	/** Minimum lead over the runner-up score. Default 0.08. */
	distinctMargin?: number
	/** Resolve "ok" / "oui" / "nope" against a two-option question. Default true. */
	useYesNoAliases?: boolean
}

export interface OptionMatch {
	/** The matched option; undefined when nothing was accepted. */
	option?: string
	/** Score of `option`, or of the best candidate when the answer was rejected. */
	score: number
	/** Why no option was accepted. */
	reason?: OptionMatchRejection
	/** Closest other candidate, for diagnostics and confirmation prompts. */
	runnerUp?: { option: string; score: number }
}

export const DEFAULT_MIN_SCORE = 0.55
export const DEFAULT_DISTINCT_MARGIN = 0.08
/** A score this high is accepted even when another option looks almost alike. */
const DECISIVE_SCORE = 0.95
/** Caps similarity so containment (0.85+) always outranks a typo correction. */
const SIMILARITY_CAP = 0.9
/** Score given to a bare ordinal ("2") or letter ("b"). */
const ORDINAL_SCORE = 0.98
/** Score given to a yes/no word matched against a two-option question. */
const YES_NO_SCORE = 0.9

const AFFIRMATIVE = new Set([
	"y",
	"yes",
	"yeah",
	"yep",
	"ok",
	"okay",
	"oui",
	"ouais",
	"approuve",
	"approuver",
	"approve",
	"approved",
	"accept",
	"accepted",
	"accepte",
	"accepter",
	"valide",
	"valider",
	"continue",
	"confirme",
	"confirmer",
	"correct",
	"d accord",
	"daccord",
	"go",
	"vas y",
	"true",
])

const NEGATIVE = new Set([
	"n",
	"no",
	"nope",
	"non",
	"stop",
	"annule",
	"annuler",
	"cancel",
	"cancelled",
	"refuse",
	"refuser",
	"reject",
	"rejected",
	"deny",
	"denied",
	"false",
	"pas d accord",
])

/**
 * Fold case, accents and punctuation so "Oui !" and " oui " are the same
 * answer. Digits survive (an option can legitimately be "Option 2") and runs of
 * separators collapse to a single space so token comparison is reliable.
 */
export function normalizeAnswer(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ")
}

/** True when a label is itself a yes/no word ("Approve", "Non", "Reject"). */
function isYesNoLabel(label: string): boolean {
	const normalized = normalizeAnswer(label)
	return AFFIRMATIVE.has(normalized) || NEGATIVE.has(normalized)
}

/**
 * Which side of a yes/no question an answer takes. The whole answer is checked
 * first ("d'accord"), then its tokens, so a short keyboard answer like
 * "je valide" still resolves. A mix of both sides ("yes no") returns undefined
 * so the fuzzy ladder decides instead of a coin flip.
 */
function yesNoIntent(normalizedAnswer: string): "affirmative" | "negative" | undefined {
	if (AFFIRMATIVE.has(normalizedAnswer)) {
		return "affirmative"
	}
	if (NEGATIVE.has(normalizedAnswer)) {
		return "negative"
	}

	let affirmative = 0
	let negative = 0
	for (const token of tokens(normalizedAnswer)) {
		if (AFFIRMATIVE.has(token)) {
			affirmative++
		}
		if (NEGATIVE.has(token)) {
			negative++
		}
	}
	if (affirmative > 0 && negative === 0) {
		return "affirmative"
	}
	if (negative > 0 && affirmative === 0) {
		return "negative"
	}
	return undefined
}

function tokens(normalized: string): string[] {
	return normalized.length > 0 ? normalized.split(" ") : []
}

/** True when `candidate` appears in `container` as a contiguous token run. */
function containsTokenRun(container: readonly string[], candidate: readonly string[]): boolean {
	if (candidate.length === 0 || candidate.length > container.length) {
		return false
	}
	for (let start = 0; start <= container.length - candidate.length; start++) {
		let run = true
		for (let offset = 0; offset < candidate.length; offset++) {
			if (container[start + offset] !== candidate[offset]) {
				run = false
				break
			}
		}
		if (run) {
			return true
		}
	}
	return false
}

// ---- similarity scoring ----

function jaro(a: string, b: string): number {
	if (a === b) {
		return 1
	}
	if (a.length === 0 || b.length === 0) {
		return 0
	}

	const matchDistance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
	const aMatched = new Array<boolean>(a.length).fill(false)
	const bMatched = new Array<boolean>(b.length).fill(false)
	let matches = 0
	for (let i = 0; i < a.length; i++) {
		const start = Math.max(0, i - matchDistance)
		const end = Math.min(i + matchDistance + 1, b.length)
		for (let j = start; j < end; j++) {
			if (bMatched[j] || a[i] !== b[j]) {
				continue
			}
			aMatched[i] = true
			bMatched[j] = true
			matches++
			break
		}
	}
	if (matches === 0) {
		return 0
	}

	let transpositions = 0
	let cursor = 0
	for (let i = 0; i < a.length; i++) {
		if (!aMatched[i]) {
			continue
		}
		while (!bMatched[cursor]) {
			cursor++
		}
		if (a[i] !== b[cursor]) {
			transpositions++
		}
		cursor++
	}

	return (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3
}

function jaroWinkler(a: string, b: string): number {
	const base = jaro(a, b)
	if (base < 0.7) {
		return base
	}
	let prefix = 0
	const maxPrefix = Math.min(4, a.length, b.length)
	while (prefix < maxPrefix && a[prefix] === b[prefix]) {
		prefix++
	}
	return base + prefix * 0.1 * (1 - base)
}

function scoreOption(normalizedAnswer: string, answerTokens: readonly string[], option: string): number {
	const normalizedOption = normalizeAnswer(option)
	if (normalizedOption.length === 0 || normalizedAnswer.length === 0) {
		return 0
	}
	if (normalizedAnswer === normalizedOption) {
		return 1
	}

	const optionTokens = tokens(normalizedOption)
	// The answer repeats the whole label, possibly with extra guidance
	// ("Yes: go ahead") - a stronger signal than any similarity score.
	if (containsTokenRun(answerTokens, optionTokens)) {
		return 0.92
	}
	// The answer is a fragment of the label ("parser" for "Refactor the
	// parser"), i.e. a keyword was typed instead of the full sentence.
	if (containsTokenRun(optionTokens, answerTokens)) {
		return 0.85
	}

	return Math.min(jaroWinkler(normalizedAnswer, normalizedOption), SIMILARITY_CAP)
}

/** Words that introduce an ordinal in a spoken answer ("option 1", "choix 2"). */
const ORDINAL_PREFIXES = new Set(["option", "options", "choix", "reponse", "reponses", "numero", "num", "n", "no"])

/**
 * Spoken ordinals. A voice answer is far more likely to be "la première" or
 * "2" than the option's exact wording, and the device reads the options out with
 * their numbers, so both forms must resolve.
 */
const ORDINAL_WORDS: Record<string, number> = {
	premier: 1,
	premiere: 1,
	first: 1,
	one: 1,
	un: 1,
	une: 1,
	deuxieme: 2,
	second: 2,
	seconde: 2,
	deux: 2,
	two: 2,
	troisieme: 3,
	trois: 3,
	third: 3,
	three: 3,
	quatrieme: 4,
	quatre: 4,
	four: 4,
	cinquieme: 5,
	cinq: 5,
	five: 5,
	sixieme: 6,
	six: 6,
	septieme: 7,
	sept: 7,
	huitieme: 8,
	huit: 8,
	neuvieme: 9,
	neuf: 9,
	dixieme: 10,
	dix: 10,
}

/** Articles and fillers that precede an ordinal in natural speech. */
const LEADING_FILLER = new Set(["la", "le", "l", "les", "the", "a", "an"])

/**
 * The single meaningful word of an ordinal answer, or undefined when the answer
 * is something else. Drops leading filler so "la première" and "option 2" both
 * reduce to their ordinal, while leaving real answers ("le parser") untouched
 * for the fuzzy ladder.
 */
function ordinalWord(tokens: readonly string[]): string | undefined {
	let index = 0
	while (index < tokens.length - 1 && (ORDINAL_PREFIXES.has(tokens[index]) || LEADING_FILLER.has(tokens[index]))) {
		index++
	}
	return tokens.length - index === 1 ? tokens[index] : undefined
}

/**
 * A bare "2", a labelled "option 2", a spoken "la première" or a letter "b"
 * selects the option at that position. Runs after the exact-label check, so an
 * option literally named "One" still wins over the ordinal reading of "one".
 */
function scoreByPosition(normalizedAnswer: string, options: readonly string[]): number | undefined {
	const word = ordinalWord(normalizedAnswer.split(" "))
	if (word === undefined) {
		return undefined
	}

	const asOrdinal = (value: number): number | undefined => (value >= 1 && value <= options.length ? value - 1 : undefined)

	if (/^[0-9]{1,2}$/.test(word)) {
		return asOrdinal(Number.parseInt(word, 10))
	}
	// "1er", "2eme", "3ème" (the accents are already folded by normalizeAnswer).
	if (/^[0-9]{1,2}(er|ere|eme|e)$/.test(word)) {
		return asOrdinal(Number.parseInt(word, 10))
	}
	if (/^[a-z]$/.test(word)) {
		const index = word.charCodeAt(0) - 97
		return index < options.length ? index : undefined
	}
	const spelled = ORDINAL_WORDS[word]
	return spelled === undefined ? undefined : asOrdinal(spelled)
}

/**
 * A spoken answer often carries a leading article ("le parser", "la deuxième");
 * dropping it keeps the token comparison against the label meaningful
 * ("Refactor the parser"). Returns the input when it has no such prefix.
 */
function stripLeadingFiller(normalized: string): string {
	const tokens = normalized.split(" ")
	let index = 0
	while (index < tokens.length - 1 && LEADING_FILLER.has(tokens[index])) {
		index++
	}
	return index === 0 ? normalized : tokens.slice(index).join(" ")
}

/**
 * Resolve `answer` against `options`.
 *
 * Ordering is deterministic: candidates are sorted by descending score, then by
 * their position in `options`, so equally scoring entries always resolve to the
 * first occurrence. Blank and duplicate labels are dropped beforehand.
 */
export function matchOption(answer: string, options: readonly string[], settings: OptionMatchOptions = {}): OptionMatch {
	const minScore = settings.minScore ?? DEFAULT_MIN_SCORE
	const distinctMargin = settings.distinctMargin ?? DEFAULT_DISTINCT_MARGIN
	const useYesNoAliases = settings.useYesNoAliases ?? true

	const normalizedAnswer = normalizeAnswer(answer)
	if (normalizedAnswer.length === 0) {
		return { score: 0, reason: "empty_answer" }
	}

	const unique = [...new Set(options.map((option) => option.trim()).filter((option) => option.length > 0))]
	if (unique.length === 0) {
		return { score: 0, reason: "no_options" }
	}

	// An exact label always wins with a full score: nothing downstream can beat
	// it, and the ambiguity guard must not turn an exact answer into a question.
	const exact = unique.find((option) => normalizeAnswer(option) === normalizedAnswer)
	if (exact !== undefined) {
		return { option: exact, score: 1 }
	}

	const positional = scoreByPosition(normalizedAnswer, unique)
	if (positional !== undefined) {
		return { option: unique[positional], score: ORDINAL_SCORE }
	}

	// Yes/no words only resolve against a genuine yes/no pair: with two
	// unrelated labels ("Refactor the parser" / "Rewrite the tests") a "non"
	// must NOT silently select the second one, so the shortcut is gated on the
	// labels themselves being yes/no-ish (which is the case for tool approvals,
	// whose options the adapter builds as Approve/Reject).
	const yesNoPair = useYesNoAliases && unique.length === 2 && unique.some((option) => isYesNoLabel(option))
	if (yesNoPair) {
		const intent = yesNoIntent(normalizedAnswer)
		if (intent === "affirmative") {
			return { option: unique[0], score: YES_NO_SCORE }
		}
		if (intent === "negative") {
			return { option: unique[1], score: YES_NO_SCORE }
		}
	}

	const scoringAnswer = stripLeadingFiller(normalizedAnswer)
	const answerTokens = tokens(scoringAnswer)
	const scored = unique
		.map((option, index) => ({ option, index, score: scoreOption(scoringAnswer, answerTokens, option) }))
		.sort((left, right) => right.score - left.score || left.index - right.index)

	const best = scored[0]
	const runnerUp = scored.length > 1 ? scored[1] : undefined
	const lead = best.score - (runnerUp?.score ?? 0)

	if (best.score < minScore) {
		return {
			score: best.score,
			reason: "below_threshold",
			runnerUp: runnerUp ? { option: runnerUp.option, score: runnerUp.score } : undefined,
		}
	}
	if (best.score < DECISIVE_SCORE && lead < distinctMargin) {
		return {
			score: best.score,
			reason: "ambiguous",
			runnerUp: runnerUp ? { option: runnerUp.option, score: runnerUp.score } : undefined,
		}
	}

	return { option: best.option, score: best.score }
}
