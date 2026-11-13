//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by yukisekimi on 2026-06-09.
//

import SafariServices
import Synchronization
import os

private let logger = Logger(subsystem: "mannychau.Lithuanify.Extension", category: "gloss")

#if canImport(FoundationModels)
import FoundationModels
#endif

/// A text block from the page and the words in it the dictionary didn't know.
struct GlossBlock {
    let text: String
    let words: [String]
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey]

        guard let dict = message as? [String: Any],
              let command = dict["command"] as? String else {
            complete(context, with: ["error": "invalid message"])
            return
        }

        switch command {
        case "modelStatus":
            Self.prewarm()
            complete(context, with: ["available": Self.modelIsAvailable()])

        case "gloss":
            let raw = (dict["blocks"] as? [Any]) ?? []
            let blocks = raw.map { entry -> GlossBlock in
                let item = entry as? [String: Any]
                return GlossBlock(text: item?["text"] as? String ?? "",
                                  words: item?["words"] as? [String] ?? [])
            }
            handleGloss(blocks: blocks, context: context)

        default:
            complete(context, with: ["error": "unknown command: \(command)"])
        }
    }

    // MARK: - Response helper

    private func complete(_ context: NSExtensionContext, with payload: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: payload]
        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }

    // MARK: - On-device model

    private static func modelIsAvailable() -> Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            return SystemLanguageModel.default.isAvailable
        }
        #endif
        return false
    }

    /// Load the model ahead of the first real request and park a warm session.
    static func prewarm() {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            SessionPool.shared.fillIfEmpty()
        }
        #endif
    }

    /// Gloss the unknown words of each block. Replies with one array of
    private func handleGloss(blocks: [GlossBlock], context: NSExtensionContext) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *), SystemLanguageModel.default.isAvailable {
            Task {
                let (results, ok) = await Glosser.gloss(blocks)
                self.complete(context, with: ["available": true, "results": results, "ok": ok])
            }
            return
        }
        #endif
        complete(context, with: ["available": false, "results": []])
    }
}

#if canImport(FoundationModels)

/// Holds one prewarmed session. Each request takes it (so two requests never
/// share a session) and a fresh warm one is parked for the next request.
@available(iOS 26.0, macOS 26.0, *)
final class SessionPool: Sendable {
    static let shared = SessionPool()

    private let warm = Mutex<LanguageModelSession?>(nil)

    static func makeSession() -> LanguageModelSession {
        LanguageModelSession(
            model: SystemLanguageModel(guardrails: .permissiveContentTransformations),
            instructions: Glosser.instructions
        )
    }

    func take() -> LanguageModelSession {
        warm.withLock { $0.take() } ?? Self.makeSession()
    }

    func fillIfEmpty() {
        guard SystemLanguageModel.default.isAvailable else { return }
        warm.withLock { warm in
            guard warm == nil else { return }
            let session = Self.makeSession()
            session.prewarm()
            warm = session
        }
    }
}

@available(iOS 26.0, macOS 26.0, *)
enum Glosser {

    static let instructions = """
    You help an English speaker read Lithuanian. The user gives a Lithuanian \
    text and a numbered list of words from it. For each numbered word, give a \
    short English meaning (1-3 words) that fits how the word is used in the \
    text. Reply with one line per word: its number, a period, and the \
    meaning. Never repeat the Lithuanian word. Example:
    1. house
    2. went
    """

    /// Words per model call. Small calls keep each answer short and complete.
    static let maxWordsPerJob = 20
    /// Context text per model call, in words.
    static let maxContextWords = 60
    /// Model calls on one session before starting a fresh one, so the
    /// transcript never fills the context window.
    static let maxTurnsPerSession = 4

    /// One model call: some context text and the words to gloss in it.
    struct Job {
        var context: [String] = []
        var contextWords = 0
        var targets: [(block: Int, word: Int, text: String)] = []
    }

    static func gloss(_ blocks: [GlossBlock]) async -> (results: [[String]], ok: [Bool]) {
        var results = blocks.map { Array(repeating: "", count: $0.words.count) }
        var ok = Array(repeating: true, count: blocks.count)
        let jobs = makeJobs(blocks)
        guard !jobs.isEmpty else { return (results, ok) }

        var session = SessionPool.shared.take()
        var turns = 0

        for job in jobs {
            if turns >= maxTurnsPerSession {
                session = SessionPool.makeSession()
                turns = 0
            }
            var items = await run(job, on: session)
            turns += 1
            if items == nil && turns > 1 {
                // A reused session may have run out of context; retry fresh.
                session = SessionPool.makeSession()
                items = await run(job, on: session)
                turns = 1
            }
            guard let items else {
                for target in job.targets { ok[target.block] = false }
                continue
            }
            for item in items {
                let index = item.i - 1
                guard job.targets.indices.contains(index) else { continue }
                let target = job.targets[index]
                let meaning = clean(item.g, word: target.text)
                guard !meaning.isEmpty else { continue }
                results[target.block][target.word] = meaning
            }
        }

        SessionPool.shared.fillIfEmpty()
        return (results, ok)
    }

    private static func run(_ job: Job, on session: LanguageModelSession) async -> [WordGloss]? {
        var prompt = "Text:\n\(job.context.joined(separator: " "))\n\nWords:\n"
        for (n, target) in job.targets.enumerated() {
            prompt += "\(n + 1). \(target.text)\n"
        }
        do {
            let response = try await session.respond(
                to: prompt,
                options: GenerationOptions(samplingMode: .greedy)
            )
            logger.debug("Model answer: \(response.content, privacy: .public)")
            return parse(response.content)
        } catch {
            logger.error("Gloss failed: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    static func parse(_ text: String) -> [WordGloss] {
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

    static let maxGlossWords = 3

    static func clean(_ gloss: String, word: String) -> String {
        let source = fold(word)
        let parts = gloss
            .components(separatedBy: ". ")
            .map { $0.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters)) }
            .filter { !$0.isEmpty }
        let english = parts.filter { part in
            !fold(part).split(whereSeparator: { !$0.isLetter }).contains { String($0) == source }
        }
        let pick = english.last ?? parts.last ?? ""
        return pick.split(separator: " ").prefix(maxGlossWords).joined(separator: " ")
    }

    private static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    /// Split each block into sentences, give each unknown word the sentence it
    /// first appears in, and pack sentences (across blocks) into small jobs.
    static func makeJobs(_ blocks: [GlossBlock]) -> [Job] {
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
                var targets: [(block: Int, word: Int, text: String)] = []
                for token in tokens {
                    if let w = remaining.removeValue(forKey: token) {
                        targets.append((b, w, block.words[w]))
                    }
                }
                // Words not found in any sentence go with the last one.
                if s == sentences.count - 1 {
                    for (word, w) in remaining.sorted(by: { $0.value < $1.value }) {
                        targets.append((b, w, word))
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

    /// Split text on sentence boundaries, then cap long runs by word count.
    static func splitIntoSentences(_ text: String, maxWords: Int = 40) -> [String] {
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

struct WordGloss {
    let i: Int
    let g: String
}
#endif
