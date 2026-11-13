//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by yukisekimi on 2026-06-09.
//

import LithuanifyCore
import SafariServices
import Synchronization
import os

private let logger = Logger(subsystem: "mannychau.Lithuanify.Extension", category: "gloss")

#if canImport(FoundationModels)
import FoundationModels
#endif

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
            handleGloss(blocks: GlossBlock.list(from: dict["blocks"]), context: context)

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
            instructions: GlossCore.instructions
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

    static let maxTurnsPerSession = 4

    static func gloss(_ blocks: [GlossBlock]) async -> (results: [[String]], ok: [Bool]) {
        var results = blocks.map { Array(repeating: "", count: $0.words.count) }
        var ok = Array(repeating: true, count: blocks.count)
        let jobs = GlossCore.makeJobs(blocks)
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
                session = SessionPool.makeSession()
                items = await run(job, on: session)
                turns = 1
            }
            guard let items else {
                for target in job.targets { ok[target.block] = false }
                continue
            }
            GlossCore.apply(items, of: job, to: &results)
        }

        SessionPool.shared.fillIfEmpty()
        return (results, ok)
    }

    private static func run(_ job: GlossCore.Job, on session: LanguageModelSession) async -> [WordGloss]? {
        do {
            let response = try await session.respond(
                to: GlossCore.prompt(for: job),
                options: GenerationOptions(samplingMode: .greedy)
            )
            logger.debug("Model answer: \(response.content, privacy: .private)")
            return GlossCore.parse(response.content)
        } catch {
            logger.error("Gloss failed: \(String(describing: error), privacy: .private)")
            return nil
        }
    }
}
#endif
