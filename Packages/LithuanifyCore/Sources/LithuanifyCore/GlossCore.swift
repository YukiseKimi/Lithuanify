import Foundation
import FoundationModels

public struct WordHint: Sendable, Equatable {
    public let lemma: String?
    public let options: [String]

    public init(lemma: String?, options: [String]) {
        self.lemma = lemma
        self.options = options
    }

    init?(message: Any?) {
        guard let item = message as? [String: Any],
              let options = item["options"] as? [String], !options.isEmpty else { return nil }
        self.init(lemma: item["lemma"] as? String, options: options)
    }
}

public struct GlossBlock: Sendable, Equatable {
    public let text: String
    public let words: [String]
    public let hints: [WordHint?]

    public init(text: String, words: [String], hints: [WordHint?] = []) {
        self.text = text
        self.words = words
        self.hints = words.indices.map { hints.indices.contains($0) ? hints[$0] : nil }
    }

    public static func list(from message: Any?) -> [GlossBlock] {
        let entries = message as? [Any] ?? []
        return entries.map { entry in
            let item = entry as? [String: Any]
            return GlossBlock(
                text: item?["text"] as? String ?? "",
                words: item?["words"] as? [String] ?? [],
                hints: (item?["hints"] as? [Any] ?? []).map(WordHint.init(message:))
            )
        }
    }
}

@Generable
public struct WordAnswer: Sendable, Equatable {
    @Guide(description: "The number of the word in the list")
    public var word: Int
    @Guide(description: "The number of the option that fits, or 0 when the word has no options or none fits")
    public var option: Int
    @Guide(description: "A short English meaning of the word as used in the text, 1 to 3 words")
    public var meaning: String

    public init(word: Int, option: Int, meaning: String) {
        self.word = word
        self.option = option
        self.meaning = meaning
    }
}

@Generable
public struct GlossAnswer: Sendable {
    @Guide(description: "One answer for each numbered word")
    public var words: [WordAnswer]
}

public enum GlossCore {

    public static let instructions = """
    You help an English speaker read Lithuanian. The user gives a Lithuanian \
    text and a numbered list of words from it. For each numbered word, give a \
    short English meaning (1-3 words) that fits how the word is used in the \
    text. When a word lists options, give the number of the option that fits \
    the text; give 0 when none fits. Never repeat the Lithuanian word.
    """

    public static let maxWordsPerJob = 20
    public static let maxContextWords = 60
    public static let maxGlossWords = 3

    public struct Target: Sendable, Equatable {
        public let block: Int
        public let word: Int
        public let text: String
        public var hint: WordHint? = nil
    }

    public struct Job: Sendable, Equatable {
        public var context: [String] = []
        public var contextWords = 0
        public var targets: [Target] = []
    }

    public static func prompt(for job: Job) -> String {
        var prompt = "Text:\n\(job.context.joined(separator: " "))\n\nWords:\n"
        for (n, target) in job.targets.enumerated() {
            prompt += "\(n + 1). \(target.text)"
            if let hint = target.hint {
                if let lemma = hint.lemma, lemma != target.text { prompt += " (form of \(lemma))" }
                let options = hint.options.enumerated().map { "\($0 + 1)) \($1)" }.joined(separator: " ")
                prompt += "; options: \(options)"
            }
            prompt += "\n"
        }
        return prompt
    }

    public static func apply(_ answers: [WordAnswer], of job: Job, to results: inout [[String]]) {
        for answer in answers {
            let index = answer.word - 1
            guard job.targets.indices.contains(index) else { continue }
            let target = job.targets[index]
            let options = target.hint?.options ?? []
            let meaning = options.indices.contains(answer.option - 1)
                ? options[answer.option - 1]
                : clean(answer.meaning, word: target.text)
            guard !meaning.isEmpty else { continue }
            results[target.block][target.word] = meaning
        }
    }

    public static func clean(_ gloss: String, word: String) -> String {
        let source = fold(word)
        let parts = joinAbbreviations(gloss.components(separatedBy: ". "))
            .map { $0.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters)) }
            .filter { !$0.isEmpty }
        let english = parts.filter { part in
            !fold(part).split(whereSeparator: { !$0.isLetter }).contains { String($0) == source }
        }
        let pick = english.last ?? parts.last ?? ""
        return pick.split(separator: " ").prefix(maxGlossWords).joined(separator: " ")
    }

    private static func joinAbbreviations(_ pieces: [String]) -> [String] {
        var joined: [String] = []
        var pending: String?
        for (n, piece) in pieces.enumerated() {
            let part = pending.map { "\($0). \(piece)" } ?? piece
            let word = piece.split(separator: " ").last.map(String.init) ?? ""
            if isAbbreviation(word) && n < pieces.count - 1 {
                pending = part
            } else {
                joined.append(part)
                pending = nil
            }
        }
        return joined
    }

    private static let abbreviations: Set<String> = ["St", "Dr", "Mr", "Mrs", "Ms", "Mt", "Jr", "Sr", "Ave", "Rd", "Prof"]

    private static func isAbbreviation(_ word: String) -> Bool {
        abbreviations.contains(word)
    }

    private static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    public static func makeJobs(_ blocks: [GlossBlock]) -> [Job] {
        var jobs: [Job] = []
        var current = Job()

        func flush() {
            if !current.targets.isEmpty { jobs.append(current) }
            current = Job()
        }

        for (b, block) in blocks.enumerated() {
            let sentences = splitIntoSentences(block.text)
            var remaining = Dictionary(block.words.enumerated().map { ($1, $0) },
                                       uniquingKeysWith: { first, _ in first })

            for (s, sentence) in sentences.enumerated() {
                let tokens = sentence.lowercased().split(whereSeparator: { !$0.isLetter }).map(String.init)
                var targets: [Target] = []
                for token in tokens {
                    if let w = remaining.removeValue(forKey: token) {
                        targets.append(Target(block: b, word: w, text: block.words[w], hint: block.hints[w]))
                    }
                }
                if s == sentences.count - 1 {
                    for (word, w) in remaining.sorted(by: { $0.value < $1.value }) {
                        targets.append(Target(block: b, word: w, text: word, hint: block.hints[w]))
                    }
                    remaining.removeAll()
                }
                if targets.isEmpty { continue }

                let wordCount = max(tokens.count, 1)
                var start = 0
                while start < targets.count {
                    let slice = targets[start..<min(start + maxWordsPerJob, targets.count)]
                    if !current.targets.isEmpty &&
                        (current.targets.count + slice.count > maxWordsPerJob ||
                         current.contextWords + wordCount > maxContextWords) {
                        flush()
                    }
                    current.context.append(sentence.trimmingCharacters(in: .whitespacesAndNewlines))
                    current.contextWords += wordCount
                    current.targets.append(contentsOf: slice)
                    start += slice.count
                }
            }
        }
        flush()
        return jobs
    }

    public static func splitIntoSentences(_ text: String, maxWords: Int = 40) -> [String] {
        var sentences: [String] = []
        var current = ""
        for ch in text {
            current.append(ch)
            if ch == "." || ch == "!" || ch == "?" || ch == ";" || ch == "\n" {
                sentences.append(current)
                current = ""
            }
        }
        if !current.isEmpty { sentences.append(current) }

        var chunks: [String] = []
        for sentence in sentences {
            if sentence.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
            let words = sentence.split(separator: " ", omittingEmptySubsequences: true)
            if words.count <= maxWords {
                chunks.append(sentence)
            } else {
                var i = 0
                while i < words.count {
                    chunks.append(words[i..<min(i + maxWords, words.count)].joined(separator: " "))
                    i += maxWords
                }
            }
        }
        return chunks.isEmpty ? [text] : chunks
    }
}
