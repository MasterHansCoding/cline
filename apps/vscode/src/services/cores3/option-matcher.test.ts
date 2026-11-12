import { describe, expect, it } from "bun:test"
import { matchOption, normalizeAnswer } from "./option-matcher"

describe("normalizeAnswer", () => {
	it("folds case, accents and surrounding punctuation", () => {
		expect(normalizeAnswer("  Oui ! ")).toBe("oui")
		expect(normalizeAnswer("Déjà-vu")).toBe("deja vu")
		expect(normalizeAnswer("Option 2")).toBe("option 2")
	})

	it("collapses separator runs so token comparison is stable", () => {
		expect(normalizeAnswer("a---b ,, c")).toBe("a b c")
	})
})

describe("matchOption", () => {
	const approveReject = ["Approve", "Reject"]

	it("rejects an empty answer", () => {
		const result = matchOption("   ", approveReject)
		expect(result.option).toBeUndefined()
		expect(result.reason).toBe("empty_answer")
		expect(result.score).toBe(0)
	})

	it("rejects when there is no usable option", () => {
		expect(matchOption("yes", ["", "   "]).reason).toBe("no_options")
		expect(matchOption("yes", []).reason).toBe("no_options")
	})

	it("matches an exact label whatever the case, accents and punctuation", () => {
		expect(matchOption("OUI !", ["Oui", "Non"])).toEqual({ option: "Oui", score: 1 })
		expect(matchOption("approve", approveReject)).toEqual({ option: "Approve", score: 1 })
	})

	it("accepts a label repeated inside a longer answer", () => {
		const result = matchOption("Yes: go ahead", ["Yes", "No"])
		expect(result.option).toBe("Yes")
		expect(result.score).toBeGreaterThan(0.85)
	})

	it("accepts a keyword that is a fragment of the label", () => {
		const result = matchOption("parser", ["Refactor the parser", "Rewrite the tests"])
		expect(result.option).toBe("Refactor the parser")
		expect(result.score).toBeGreaterThan(0.8)
	})

	it("maps a bare ordinal or letter to the option at that position", () => {
		const options = ["Alpha", "Beta", "Gamma"]
		expect(matchOption("2", options).option).toBe("Beta")
		expect(matchOption("3", options).option).toBe("Gamma")
		expect(matchOption("b", options).option).toBe("Beta")
	})

	it("maps a labelled, suffixed or spoken ordinal", () => {
		const options = ["Alpha", "Beta", "Gamma"]
		expect(matchOption("option 1", options).option).toBe("Alpha")
		expect(matchOption("Option 2", options).option).toBe("Beta")
		expect(matchOption("choix 3", options).option).toBe("Gamma")
		expect(matchOption("numéro 2", options).option).toBe("Beta")
		expect(matchOption("1er", options).option).toBe("Alpha")
		expect(matchOption("2ème", options).option).toBe("Beta")
		expect(matchOption("deuxième", options).option).toBe("Beta")
		expect(matchOption("la première", options).option).toBe("Alpha")
		expect(matchOption("the second", options).option).toBe("Beta")
	})

	it("ignores an ordinal beyond the number of options", () => {
		const result = matchOption("option 9", ["Alpha", "Beta"])
		expect(result.option).toBeUndefined()
		expect(result.reason).toBe("below_threshold")
	})

	it("keeps an exact label ahead of the ordinal reading", () => {
		expect(matchOption("one", ["One", "Two"]).option).toBe("One")
	})

	it("does not turn a normal answer into an ordinal", () => {
		expect(matchOption("le parser", ["Refactor the parser", "Rewrite the tests"]).option).toBe("Refactor the parser")
	})

	it("ignores an out-of-range ordinal instead of guessing", () => {
		const result = matchOption("9", approveReject)
		expect(result.option).toBeUndefined()
		expect(result.reason).toBe("below_threshold")
	})

	it("resolves yes/no answers against a yes/no pair", () => {
		expect(matchOption("ok", approveReject).option).toBe("Approve")
		expect(matchOption("nope", approveReject).option).toBe("Reject")
		expect(matchOption("je valide", approveReject).option).toBe("Approve")
		expect(matchOption("non merci", approveReject).option).toBe("Reject")
	})

	it("does not let a yes/no word pick one of two unrelated labels", () => {
		const options = ["Refactor the parser", "Rewrite the tests"]
		const result = matchOption("non", options)
		expect(result.option).toBeUndefined()
		expect(result.reason).toBe("below_threshold")
	})

	it("does not decide when the answer carries both sides", () => {
		const result = matchOption("yes no", approveReject)
		expect(result.option).toBeUndefined()
		// Either outcome is correct: what matters is that no coin flip happened.
		expect(result.reason === "ambiguous" || result.reason === "below_threshold").toBe(true)
	})

	it("reports ambiguity instead of picking between near-identical labels", () => {
		const result = matchOption("approche", ["Approche douce", "Approche douce maintenant"])
		expect(result.option).toBeUndefined()
		expect(result.reason).toBe("ambiguous")
		expect(result.runnerUp?.option).toBe("Approche douce maintenant")
	})

	it("accepts a decisive match even when another label is close", () => {
		const result = matchOption("Approche douce", ["Approche douce", "Approche douce maintenant"])
		expect(result).toEqual({ option: "Approche douce", score: 1 })
	})

	it("collapses duplicate labels onto the first occurrence", () => {
		expect(matchOption("yes", ["Yes", "Yes", "No"]).option).toBe("Yes")
	})

	it("honours custom thresholds", () => {
		expect(matchOption("banana", approveReject).reason).toBe("below_threshold")
		expect(matchOption("banana", approveReject, { minScore: 0.1 }).option).toBe("Approve")
	})

	it("can disable the yes/no shortcut", () => {
		const result = matchOption("ok", approveReject, { useYesNoAliases: false })
		expect(result.option).toBeUndefined()
	})
})
