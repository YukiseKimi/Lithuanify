import LithuanifyCore
import Testing

/// Answers each job by the script, and logs which session got which job.
private final class Script {
    var log: [(session: Int, job: Int)] = []
    let outcome: (_ session: Int, _ job: Int) -> GlossOutcome
    private var sessions = 0
    private var jobs: [GlossCore.Job] = []

    init(_ outcome: @escaping (_ session: Int, _ job: Int) -> GlossOutcome = { _, _ in .answered([]) }) {
        self.outcome = outcome
    }

    func session() -> FakeSession {
        sessions += 1
        return FakeSession(id: sessions, script: self)
    }

    func answer(_ job: GlossCore.Job, on session: Int) -> GlossOutcome {
        if !jobs.contains(job) { jobs.append(job) }
        let n = jobs.firstIndex(of: job)!
        log.append((session, n))
        return outcome(session, n)
    }
}

private struct FakeSession: GlossSession {
    let id: Int
    let script: Script

    func answer(_ job: GlossCore.Job) async -> GlossOutcome {
        script.answer(job, on: id)
    }
}

/// One block per job: each has maxWordsPerJob words, so no two share a job.
private func blocks(_ count: Int) -> [GlossBlock] {
    (0..<count).map { b in
        let words = (0..<GlossCore.maxWordsPerJob).map { w in "žodis" + String(repeating: "a", count: b + 1) + String(repeating: "b", count: w + 1) }
        return GlossBlock(text: words.joined(separator: " ") + ".", words: words)
    }
}

private func run(_ blocks: [GlossBlock], _ script: Script) async -> GlossRun {
    await Glosser.gloss(blocks, first: script.session(), fresh: script.session)
}

struct GlosserTests {
    @Test func eachJobIsAskedOnceAndAnAnswerFillsItsWords() async {
        let input = blocks(2)
        let script = Script { _, job in .answered([WordAnswer(word: 1, option: 0, meaning: "word \(job)")]) }
        let result = await run(input, script)
        #expect(script.log.map(\.job) == [0, 1])
        #expect(result.ok == [true, true])
        #expect(result.rateLimited == false)
        #expect(result.results[0][0] == "word 0")
        #expect(result.results[1][0] == "word 1")
    }

    @Test func aSessionIsReplacedAfterItsLastTurn() async {
        let script = Script()
        _ = await run(blocks(Glosser.maxTurnsPerSession + 1), script)
        #expect(script.log.map(\.session) == Array(repeating: 1, count: Glosser.maxTurnsPerSession) + [2])
    }

    @Test func aFailedJobOnAUsedSessionIsAskedOnceMoreOnAFreshOne() async {
        let script = Script { session, job in job == 1 && session == 1 ? .failed : .answered([]) }
        let result = await run(blocks(3), script)
        #expect(script.log.map(\.session) == [1, 1, 2, 2])
        #expect(script.log.map(\.job) == [0, 1, 1, 2])
        #expect(result.ok == [true, true, true])
    }

    @Test func aJobThatFailsOnAFreshSessionMarksItsBlockForTheCallerToRetry() async {
        let script = Script { _, job in job == 0 ? .failed : .answered([]) }
        let result = await run(blocks(2), script)
        #expect(script.log.map(\.job) == [0, 1])
        #expect(result.ok == [false, true])
    }

    @Test func aRefusedJobIsNotAskedAgainAndItsWordsStayWithoutAMeaning() async {
        let script = Script { _, job in job == 1 ? .refused : .answered([]) }
        let result = await run(blocks(3), script)
        #expect(script.log.map(\.job) == [0, 1, 2])
        #expect(result.ok == [true, true, true])
        #expect(result.results[1] == Array(repeating: "", count: GlossCore.maxWordsPerJob))
    }

    @Test func aRateLimitStopsTheRunAndMarksEveryBlockNotYetAnswered() async {
        let script = Script { _, job in job == 1 ? .rateLimited : .answered([]) }
        let result = await run(blocks(3), script)
        #expect(script.log.map(\.job) == [0, 1])
        #expect(result.ok == [true, false, false])
        #expect(result.rateLimited)
    }

    @Test func noBlocksNeedNoSession() async {
        let script = Script()
        let result = await run([GlossBlock(text: "Aš.", words: [])], script)
        #expect(script.log.isEmpty)
        #expect(result.ok == [true])
    }
}
