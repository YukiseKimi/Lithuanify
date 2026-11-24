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
        let request = PendingRequest(context: context)
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey]

        guard let dict = message as? [String: Any],
              let command = dict["command"] as? String else {
            request.complete(with: ["error": "invalid message"])
            return
        }

        switch command {
        case "modelStatus":
            Self.prewarm()
            request.complete(with: ["available": AIStatus.current == .ready])

        case "gloss":
            Self.gloss(GlossBlock.list(from: dict["blocks"]), for: request)

        default:
            request.complete(with: ["error": "unknown command: \(command)"])
        }
    }

    // MARK: - On-device model

    /// Load the model ahead of the first real request and park a warm session.
    static func prewarm() {
        SessionPool.shared.fillIfEmpty()
    }

    private static func gloss(_ blocks: [GlossBlock], for request: PendingRequest) {
        guard AIStatus.current == .ready else {
            request.complete(with: ["available": false, "results": []])
            return
        }
        Task {
            let run = await Glosser.gloss(blocks, first: SessionPool.shared.take(), fresh: SessionPool.makeSession)
            if !run.rateLimited { SessionPool.shared.fillIfEmpty() }
            request.complete(with: [
                "available": true, "results": run.results, "ok": run.ok, "rateLimited": run.rateLimited,
            ])
        }
    }
}

/// One request from Safari, answered once. Safari hands the handler a context
/// per request and waits for a single completeRequest call, which may come
/// from any thread; nothing else uses the context after beginRequest returns.
/// So the context can move to the task that answers it, though
/// NSExtensionContext is not marked Sendable.
private struct PendingRequest: @unchecked Sendable {
    let context: NSExtensionContext

    func complete(with payload: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: payload]
        context.completeRequest(returningItems: [response], completionHandler: nil)
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
