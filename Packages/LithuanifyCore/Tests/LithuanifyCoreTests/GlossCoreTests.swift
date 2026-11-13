import LithuanifyCore
import Testing

struct CleanTests {
    @Test(arguments: [
        ("ankstų", "period. corner of", "corner of"),
        ("penktadienio", "day. Friday", "Friday"),
        ("naugarduko", "street. Naugarduko", "street"),
        ("gatvės", "roads. gatvės", "roads"),
        ("daugiabutyje", "doors. daugiabutyje", "doors"),
        ("gaisras", "light. gaisras", "light"),
        ("užsidegė", "fixed. užsidegė", "fixed"),
        ("sendaikčiai", "rules. sendaikčiai", "rules"),
        ("naugarduko", "Naugarduko street", "Naugarduko street"),
        ("buto", "room", "room"),
        ("x", "a very long answer that goes on and on", "a very long"),
        ("ir", "first. ir", "first"),
        ("petro", "St. Peter", "St. Peter"),
        ("daktaras", "Dr. Smith", "Dr. Smith"),
        ("aikštė", "square. St. Mark", "St. Mark"),
    ])
    func cleanKeepsTheEnglishMeaning(word: String, gloss: String, expected: String) {
        #expect(GlossCore.clean(gloss, word: word) == expected)
    }
}

struct ParseTests {
    @Test(arguments: [
        ("1. house", [WordGloss(i: 1, g: "house")]),
        ("2) went.", [WordGloss(i: 2, g: "went")]),
        ("3: gatvės - street", [WordGloss(i: 3, g: "street")]),
        ("Here are the meanings:\n1. fire\n\n2. smoke;", [WordGloss(i: 1, g: "fire"), WordGloss(i: 2, g: "smoke")]),
        ("4.", []),
    ])
    func parseReadsEachAnswerLine(answer: String, expected: [WordGloss]) {
        #expect(GlossCore.parse(answer) == expected)
    }
}

struct BlockListTests {
    @Test func malformedEntriesKeepTheirPlace() {
        let message: [Any] = [
            ["text": "Bad block without words"],
            "not a block",
            ["text": "Aš skaitau knygą.", "words": ["skaitau"]],
        ]
        let blocks = GlossBlock.list(from: message)
        #expect(blocks == [
            GlossBlock(text: "Bad block without words", words: []),
            GlossBlock(text: "", words: []),
            GlossBlock(text: "Aš skaitau knygą.", words: ["skaitau"]),
        ])
    }

    @Test func missingBlocksGiveAnEmptyList() {
        #expect(GlossBlock.list(from: nil).isEmpty)
    }
}

struct JobTests {
    @Test func eachWordGoesWithTheSentenceItIsIn() {
        let block = GlossBlock(
            text: "Vilniaus senamiestis gražus. Kaunas didelis.",
            words: ["kaunas", "senamiestis"]
        )
        let jobs = GlossCore.makeJobs([block])
        let targets = jobs.flatMap(\.targets)
        #expect(targets.map(\.text).sorted() == ["kaunas", "senamiestis"])
        #expect(targets.map(\.word).sorted() == [0, 1])
        #expect(jobs.flatMap(\.context) == ["Vilniaus senamiestis gražus.", "Kaunas didelis."])
    }

    @Test func noJobHoldsMoreThanTheWordLimit() {
        let letters = Array("abcdefghij")
        let words = (0..<45).map { "ž" + String(letters[$0 / 10]) + String(letters[$0 % 10]) }
        let block = GlossBlock(text: words.joined(separator: " "), words: words)
        let jobs = GlossCore.makeJobs([block])
        #expect(Set(words).count == 45)
        #expect(jobs.count == 3)
        #expect(jobs.allSatisfy { $0.targets.count <= GlossCore.maxWordsPerJob })
        #expect(jobs.flatMap(\.targets).map(\.text) == words)
    }

    @Test func blocksWithNoWordsMakeNoJobs() {
        let jobs = GlossCore.makeJobs([GlossBlock(text: "Labas.", words: [])])
        #expect(jobs.isEmpty)
    }

    @Test func promptNumbersTheWordsInOrder() throws {
        let job = try #require(GlossCore.makeJobs([
            GlossBlock(text: "Aš skaitau knygą.", words: ["skaitau", "knygą"])
        ]).first)
        #expect(GlossCore.prompt(for: job) == "Text:\nAš skaitau knygą.\n\nWords:\n1. skaitau\n2. knygą\n")
    }
}

struct ApplyTests {
    @Test func answersLandOnTheirBlockAndWord() throws {
        let blocks = [
            GlossBlock(text: "Labas.", words: []),
            GlossBlock(text: "Penktadienio rytą.", words: ["penktadienio", "rytą"]),
        ]
        let job = try #require(GlossCore.makeJobs(blocks).first)
        var results = blocks.map { Array(repeating: "", count: $0.words.count) }
        GlossCore.apply([
            WordGloss(i: 1, g: "day. Friday"),
            WordGloss(i: 2, g: "morning"),
            WordGloss(i: 0, g: "ignored"),
            WordGloss(i: 9, g: "ignored"),
        ], of: job, to: &results)
        #expect(results == [[], ["Friday", "morning"]])
    }
}
