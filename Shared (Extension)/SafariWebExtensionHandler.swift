//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by yukisekimi on 2026-06-09.
//

import FoundationModels
import LithuanifyCore
import SafariServices
import Synchronization
import os

private let logger = Logger(subsystem: "mannychau.Lithuanify.Extension", category: "gloss")

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
            complete(context, with: ["available": AIStatus.current == .ready])

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

    /// Load the model ahead of the first real request and park a warm session.
    static func prewarm() {
        SessionPool.shared.fillIfEmpty()
    }

    private func handleGloss(blocks: [GlossBlock], context: NSExtensionContext) {
        guard AIStatus.current == .ready else {
            complete(context, with: ["available": false, "results": []])
            return
        }
        Task {
            let run = await Glosser.gloss(blocks, first: SessionPool.shared.take(), fresh: SessionPool.makeSession)
            if !run.rateLimited { SessionPool.shared.fillIfEmpty() }
            self.complete(context, with: [
                "available": true, "results": run.results, "ok": run.ok, "rateLimited": run.rateLimited,
            ])
        }
    }
}

/// Holds one prewarmed session. Each request takes it (so two requests never
/// share a session) and a fresh warm one is parked for the next request.
final class SessionPool: Sendable {
    static let shared = SessionPool()

    private let warm = Mutex<LanguageModelSession?>(nil)

    static func makeSession() -> ModelSession {
        ModelSession(session: newModelSession())
    }

    private static func newModelSession() -> LanguageModelSession {
        LanguageModelSession(
            model: SystemLanguageModel(guardrails: .permissiveContentTransformations),
            instructions: GlossCore.instructions
        )
    }

    func take() -> ModelSession {
        ModelSession(session: warm.withLock { $0.take() } ?? Self.newModelSession())
    }

    func fillIfEmpty() {
        guard AIStatus.current == .ready else { return }
        warm.withLock { warm in
            guard warm == nil else { return }
            let session = Self.newModelSession()
            session.prewarm()
            warm = session
        }
    }
}

/// Apple's on-device model as a GlossSession: one turn per job, errors sorted
/// into the outcomes Glosser acts on.
struct ModelSession: GlossSession {
    let session: LanguageModelSession

    func answer(_ job: GlossCore.Job) async -> GlossOutcome {
        do {
            let response = try await session.respond(
                to: GlossCore.prompt(for: job),
                generating: GlossAnswer.self,
                options: GenerationOptions(samplingMode: .greedy)
            )
            logger.debug("Model answer: \(String(describing: response.content.words), privacy: .private)")
            return .answered(response.content.words)
        } catch LanguageModelSession.GenerationError.rateLimited {
            logger.notice("Gloss rate limited")
            return .rateLimited
        } catch LanguageModelSession.GenerationError.guardrailViolation, LanguageModelSession.GenerationError.refusal {
            logger.notice("Gloss refused by the model's guardrails")
            return .refused
        } catch {
            logger.error("Gloss failed: \(String(describing: error), privacy: .private)")
            return .failed
        }
    }
}
