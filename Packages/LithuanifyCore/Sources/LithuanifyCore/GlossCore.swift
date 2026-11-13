import Foundation

public struct GlossBlock: Sendable, Equatable {
    public let text: String
    public let words: [String]

    public init(text: String, words: [String]) {
        self.text = text
        self.words = words
    }

    public static func list(from message: Any?) -> [GlossBlock] {
        let entries = message as? [Any] ?? []
        return entries.map { entry in
            let item = entry as? [String: Any]
            return GlossBlock(
                text: item?["text"] as? String ?? "",
                words: item?["words"] as? [String] ?? []
            )
        }
    }
}

public struct WordGloss: Sendable, Equatable {
    public let i: Int
    public let g: String

    public init(i: Int, g: String) {
        self.i = i
        self.g = g
    }
}

public enum GlossCore {

    public static let instructions = """
    You help an English speaker read Lithuanian. The user gives a Lithuanian \
    text and a numbered list of words from it. For each numbered word, give a \
    short English meaning (1-3 words) that fits how the word is used in the \
    text. Reply with one line per word: its number, a period, and the \
    meaning. Never repeat the Lithuanian word. Example:
    1. house
    2. went
    """

    public static let maxWordsPerJob = 20
    public static let maxContextWords = 60
    public static let maxGlossWords = 3

    public struct Target: Sendable, Equatable {
        public let block: Int
        public let word: Int
        public let text: String
    }

    public struct Job: Sendable, Equatable {
        public var context: [String] = []
        public var contextWords = 0
        public var targets: [Target] = []
    }

    public static func prompt(for job: Job) -> String {
        var prompt = "Text:\n\(job.context.joined(separator: " "))\n\nWords:\n"
        for (n, target) in job.targets.enumerated() {
            prompt += "\(n + 1). \(target.text)\n"
        }
        return prompt
    }

    public static func apply(_ items: [WordGloss], of job: Job, to results: inout [[String]]) {
        for item in items {
            let index = item.i - 1
            guard job.targets.indices.contains(index) else { continue }
            let target = job.targets[index]
            let meaning = clean(item.g, word: target.text)
            guard !meaning.isEmpty else { continue }
            results[target.block][target.word] = meaning
        }
    }

    public static func parse(_ text: String) -> [WordGloss] {
        var out: [WordGloss] = []
        for line in text.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let digits = trimmed.prefix(while: { $0.isNumber })
            guard let i = Int(digits) else { continue }
            var rest = trimmed.dropFirst(digits.count).drop(while: { ".):-= \t".contains($0) })
            if let sep = rest.range(of: " - ") ?? rest.range(of: " = ") ?? rest.range(of: ": ") {
                rest = rest[sep.upperBound...]
            }
            var gloss = rest.trimmingCharacters(in: .whitespaces)
            while let last = gloss.last, ".,;".contains(last) { gloss.removeLast() }
            if !gloss.isEmpty { out.append(WordGloss(i: i, g: gloss)) }
        }
        return out
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

    private static func isAbbreviation(_ word: String) -> Bool {
        (1...3).contains(word.count) && word.allSatisfy(\.isLetter) && word.first?.isUppercase == true
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
                        targets.append(Target(block: b, word: w, text: block.words[w]))
                    }
                }
                if s == sentences.count - 1 {
                    for (word, w) in remaining.sorted(by: { $0.value < $1.value }) {
                        targets.append(Target(block: b, word: w, text: word))
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
