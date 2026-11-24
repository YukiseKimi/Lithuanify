/// What one model turn gave for one job.
public enum GlossOutcome: Sendable, Equatable {
    case answered([WordAnswer])
    /// Something went wrong; a fresh session may do better.
    case failed
    /// The model's guardrails refused the text. Generation is greedy, so asking
    /// again gives the same refusal: the words stay without a meaning.
    case refused
    /// The system is limiting this app; stop and wait.
    case rateLimited
}

/// A model session that answers gloss jobs, one turn per job.
public protocol GlossSession {
    func answer(_ job: GlossCore.Job) async -> GlossOutcome
}

/// The meanings for a list of blocks. `ok[b]` is false when block `b` got no
/// answer and the caller should ask again later.
public struct GlossRun: Sendable, Equatable {
    public var results: [[String]]
    public var ok: [Bool]
    public var rateLimited: Bool
}

public enum Glosser {

    /// A session's context fills with each turn; a fresh one keeps answers short and fast.
    public static let maxTurnsPerSession = 4

    /// Runs the jobs for `blocks` in order: on `first` (usually prewarmed), then
    /// on `fresh()` sessions after maxTurnsPerSession turns or a failure.
    public static func gloss<Session: GlossSession>(
        _ blocks: [GlossBlock], first: Session, fresh: () -> Session
    ) async -> GlossRun {
        var run = GlossRun(
            results: blocks.map { Array(repeating: "", count: $0.words.count) },
            ok: Array(repeating: true, count: blocks.count),
            rateLimited: false
        )
        let jobs = GlossCore.makeJobs(blocks)
        var session = first
        var turns = 0

        for (n, job) in jobs.enumerated() {
            if turns >= maxTurnsPerSession {
                session = fresh()
                turns = 0
            }
            var outcome = await session.answer(job)
            turns += 1
            if case .failed = outcome, turns > 1 {
                session = fresh()
                outcome = await session.answer(job)
                turns = 1
            }
            switch outcome {
            case .answered(let items):
                GlossCore.apply(items, of: job, to: &run.results)
            case .refused:
                break
            case .failed:
                for target in job.targets { run.ok[target.block] = false }
            case .rateLimited:
                for rest in jobs[n...] {
                    for target in rest.targets { run.ok[target.block] = false }
                }
                run.rateLimited = true
                return run
            }
        }
        return run
    }
}
