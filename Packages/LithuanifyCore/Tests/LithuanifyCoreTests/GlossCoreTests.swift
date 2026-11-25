import Foundation
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
        ("ona", "Ona. Anna", "Anna"),
    ])
    func cleanKeepsTheEnglishMeaning(word: String, gloss: String, expected: String) {
        #expect(GlossCore.clean(gloss, word: word) == expected)
    }
}

struct BlockListTests {
    @Test func malformedEntriesKeepTheirPlace() {
        let message: [Any] = [
            ["text": "Bad block without words"],
            "not a block",
            ["text": "Aš skaitau knygą.", "words": ["skaitau"]],
            ["text": "Kasa uždaryta.", "words": ["kasa", "uždaryta"],
             "hints": [["lemma": "kasa", "options": ["cash register", "braid"]], NSNull()]],
        ]
        let blocks = GlossBlock.list(from: message)
        #expect(blocks == [
            GlossBlock(text: "Bad block without words", words: []),
            GlossBlock(text: "", words: []),
            GlossBlock(text: "Aš skaitau knygą.", words: ["skaitau"]),
            GlossBlock(text: "Kasa uždaryta.", words: ["kasa", "uždaryta"],
                       hints: [WordHint(lemma: "kasa", options: ["cash register", "braid"]), nil]),
        ])
    }

    @Test func aBlockCarriesItsEnglishTranslationWhenTheMessageHasOne() {
        let blocks = GlossBlock.list(from: [
            ["text": "Aš skaitau.", "words": ["skaitau"], "translation": "I am reading."],
            ["text": "Labas.", "words": ["labas"]],
        ] as [Any])
        #expect(blocks.map(\.translation) == ["I am reading.", nil])
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

    @Test func promptGivesTheEnglishTranslationOfEachBlockOnce() throws {
        let job = try #require(GlossCore.makeJobs([
            GlossBlock(text: "Aš skaitau. Tu rašai.", words: ["skaitau", "rašai"], translation: "I am reading. You are writing."),
            GlossBlock(text: "Labas.", words: ["labas"]),
        ]).first)
        #expect(GlossCore.prompt(for: job) == """
        Text:
        Aš skaitau. Tu rašai. Labas.

        English translation (machine, may be loose):
        I am reading. You are writing.

        Words:
        1. skaitau
        2. rašai
        3. labas

        """)
    }

    @Test func promptListsTheLemmaAndOptionsOfAWordToPick() throws {
        let job = try #require(GlossCore.makeJobs([
            GlossBlock(text: "Kasos uždarytos.", words: ["kasos", "uždarytos"],
                       hints: [WordHint(lemma: "kasa", options: ["braid", "cash register"]), nil])
        ]).first)
        #expect(GlossCore.prompt(for: job) == """
        Text:
        Kasos uždarytos.

        Words:
        1. kasos (form of kasa); options: 1) braid 2) cash register
        2. uždarytos

        """)
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
            WordAnswer(word: 1, option: 0, meaning: "day. Friday"),
            WordAnswer(word: 2, option: 0, meaning: "morning"),
            WordAnswer(word: 0, option: 0, meaning: "ignored"),
            WordAnswer(word: 9, option: 0, meaning: "ignored"),
        ], of: job, to: &results)
        #expect(results == [[], ["Friday", "morning"]])
    }

    @Test(arguments: [
        (2, "money desk", "cash register"),
        (0, "plait", "plait"),
        (7, "plait", "plait"),
    ])
    func aPickTakesItsOptionAndOtherwiseTheWrittenMeaning(option: Int, meaning: String, expected: String) throws {
        let blocks = [GlossBlock(text: "Kasa uždaryta.", words: ["kasa"],
                                 hints: [WordHint(lemma: "kasa", options: ["braid", "cash register"])])]
        let job = try #require(GlossCore.makeJobs(blocks).first)
        var results = [[""]]
        GlossCore.apply([WordAnswer(word: 1, option: option, meaning: meaning)], of: job, to: &results)
        #expect(results == [[expected]])
    }
}
