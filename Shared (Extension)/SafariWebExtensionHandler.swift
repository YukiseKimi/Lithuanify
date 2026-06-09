//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by yukisekimi on 2026-06-09.
//

import SafariServices
import os.log

#if canImport(FoundationModels)
import FoundationModels
#endif

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

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
            Self.prewarm()
            let texts = (dict["texts"] as? [String]) ?? []
            handleGloss(texts: texts, context: context)

        default:
            complete(context, with: ["error": "unknown command: \(command)"])
        }
    }

    // Shared instructions for both prewarming and glossing.
    fileprivate static let glossInstructions = """
    You help an English speaker read Lithuanian. For the user's Lithuanian \
    text, return one entry for EVERY word, in reading order — including short \
    function words like prepositions, conjunctions, and pronouns. Do not skip \
    any word. Give a short English meaning (1-3 words) that fits the word's \
    meaning in this specific context. Copy each word exactly as written, \
    including its ending and any diacritics. Only ignore standalone numbers \
    and punctuation.
    """

    // Load the model into memory once, ahead of the first real request, and
    // keep a warm session alive so subsequent glosses skip the cold start.
    private static var warmSessionHolder: Any?

    static func prewarm() {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            guard SystemLanguageModel.default.isAvailable, warmSessionHolder == nil else { return }
            let session = LanguageModelSession(instructions: glossInstructions)
            session.prewarm()
            warmSessionHolder = session
        }
        #endif
    }

    // MARK: - Response helper

    private func complete(_ context: NSExtensionContext, with payload: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [ SFExtensionMessageKey: payload ]
        } else {
            response.userInfo = [ "message": payload ]
        }
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

    // Translate each text block into per-word contextual glosses.
    private func handleGloss(texts: [String], context: NSExtensionContext) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *), SystemLanguageModel.default.isAvailable {
            Task {
                var results: [[[String: String]]] = []
                for text in texts {
                    let glosses = await Self.glossText(text)
                    results.append(glosses)
                }
                self.complete(context, with: ["available": true, "results": results])
            }
            return
        }
        #endif
        complete(context, with: ["available": false, "results": []])
    }

    #if canImport(FoundationModels)
    // Gloss a text block by splitting it into sentence-sized chunks first, so a
    // long block never exhausts the model's output before covering every word.
    @available(iOS 26.0, macOS 26.0, *)
    private static func glossText(_ text: String) async -> [[String: String]] {
        var all: [[String: String]] = []
        for chunk in splitIntoChunks(text) {
            let trimmed = chunk.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            all.append(contentsOf: await glossChunk(trimmed))
        }
        return all
    }

    @available(iOS 26.0, macOS 26.0, *)
    private static func glossChunk(_ text: String) async -> [[String: String]] {
        let session = LanguageModelSession(instructions: glossInstructions)
        do {
            let response = try await session.respond(
                to: "Lithuanian text:\n\(text)",
                generating: GlossList.self
            )
            return response.content.items.map { ["w": $0.word, "g": $0.meaning] }
        } catch {
            os_log(.error, "Lithuanify gloss failed: %@", String(describing: error))
            return []
        }
    }

    // Split text on sentence boundaries, then cap any remaining long run by word
    // count to keep each model request small and complete.
    private static func splitIntoChunks(_ text: String, maxWords: Int = 25) -> [String] {
        var sentences: [String] = []
        var current = ""
        for ch in text {
            current.append(ch)
            if ch == "." || ch == "!" || ch == "?" || ch == ";" || ch == ":" || ch == "\n" {
                sentences.append(current)
                current = ""
            }
        }
        if !current.isEmpty { sentences.append(current) }

        var chunks: [String] = []
        for sentence in sentences {
            let words = sentence.split(separator: " ", omittingEmptySubsequences: true)
            if words.count <= maxWords {
                chunks.append(sentence)
            } else {
                var i = 0
                while i < words.count {
                    let slice = words[i..<min(i + maxWords, words.count)]
                    chunks.append(slice.joined(separator: " "))
                    i += maxWords
                }
            }
        }
        return chunks
    }
    #endif
}

#if canImport(FoundationModels)
@available(iOS 26.0, macOS 26.0, *)
@Generable
struct GlossItem {
    @Guide(description: "The Lithuanian word, copied exactly as it appears in the text")
    let word: String

    @Guide(description: "A short English meaning (1-3 words) fitting this context")
    let meaning: String
}

@available(iOS 26.0, macOS 26.0, *)
@Generable
struct GlossList {
    @Guide(description: "One entry per meaningful Lithuanian word, in reading order")
    let items: [GlossItem]
}
#endif
