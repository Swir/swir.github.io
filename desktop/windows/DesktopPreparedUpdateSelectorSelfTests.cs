using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopPreparedUpdateSelectorSelfTests
{
    private static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-prepared-selector-selftest-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(root);
            NoPreparedUpdateFailsClosed(Path.Combine(root, "none"));
            SingleVerifiedCandidateIsSelected(Path.Combine(root, "single"));
            MultiplePreparedCandidatesAreAmbiguous(Path.Combine(root, "ambiguous"));
            ActiveTransactionBlocksRestart(Path.Combine(root, "active"));
            MissingCandidateStateBlocksRestart(Path.Combine(root, "missing-candidate"));
            Console.WriteLine("Desktop prepared update selector self-tests passed.");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static void NoPreparedUpdateFailsClosed(string root)
    {
        Directory.CreateDirectory(root);
        var selector = NewSelector(root, out _);
        var inventory = selector.Inspect();
        Expect(inventory.Readiness == "none" && inventory.PreparedCount == 0, "empty inventory reports no prepared update");
        ExpectCode("UPDATE_RESTART_NOT_READY", selector.RequireReady, "empty inventory cannot restart");
    }

    private static void SingleVerifiedCandidateIsSelected(string root)
    {
        var selector = NewSelector(root, out var fixture);
        var prepared = PrepareCandidate(root, fixture, "2.0.1");
        var inventory = selector.Inspect();
        Expect(inventory.Readiness == "ready" && inventory.PreparedCount == 1 && inventory.ActiveCount == 0, "single verified candidate is ready");
        var selected = selector.RequireReady();
        Expect(selected.State.TransactionId == prepared.State.TransactionId, "selector returns the canonical transaction");
        Expect(selected.Candidate.TransactionId == prepared.State.TransactionId, "selector re-verifies candidate binding");
    }

    private static void MultiplePreparedCandidatesAreAmbiguous(string root)
    {
        var selector = NewSelector(root, out var fixture);
        _ = PrepareCandidate(root, fixture, "2.1.0");
        _ = PrepareCandidate(root, fixture, "2.2.0");
        var inventory = selector.Inspect();
        Expect(inventory.Readiness == "ambiguous" && inventory.PreparedCount == 2, "multiple prepared candidates are reported as ambiguous");
        ExpectCode("UPDATE_RESTART_AMBIGUOUS", selector.RequireReady, "selector never guesses between prepared updates");
    }

    private static void ActiveTransactionBlocksRestart(string root)
    {
        var selector = NewSelector(root, out var fixture);
        var prepared = PrepareCandidate(root, fixture, "2.3.0");
        _ = fixture.Journal.Transition(prepared.State, "applying");
        var inventory = selector.Inspect();
        Expect(inventory.Readiness == "recovery-required" && inventory.ActiveCount == 1, "active transaction requires recovery");
        ExpectCode("UPDATE_RESTART_RECOVERY_REQUIRED", selector.RequireReady, "restart is blocked during active recovery state");
    }

    private static void MissingCandidateStateBlocksRestart(string root)
    {
        var selector = NewSelector(root, out var fixture);
        var prepared = PrepareCandidate(root, fixture, "2.4.0");
        File.Delete(Path.Combine(prepared.Plan.CandidateRoot, "candidate-state.json"));
        var inventory = selector.Inspect();
        Expect(inventory.Readiness == "candidate-not-ready", "missing candidate state is visible in inventory");
        ExpectCode("UPDATE_RESTART_CANDIDATE_NOT_READY", selector.RequireReady, "missing candidate state blocks restart");
    }

    private static DesktopPreparedUpdateSelector NewSelector(string root, out Fixture fixture)
    {
        var transactionsRoot = Path.Combine(root, "transactions");
        var deploymentRoot = Path.Combine(root, "deployment");
        var installRoot = Path.Combine(root, "installed");
        Directory.CreateDirectory(transactionsRoot);
        Directory.CreateDirectory(deploymentRoot);
        Directory.CreateDirectory(installRoot);
        var journal = new UpdateTransactionJournal(transactionsRoot);
        fixture = new Fixture(transactionsRoot, deploymentRoot, installRoot, journal, new UpdaterWorkerProtocol(journal, deploymentRoot), new CandidatePackagePreparer());
        return new DesktopPreparedUpdateSelector(journal, deploymentRoot, fixture.Preparer);
    }

    private static PreparedFixture PrepareCandidate(string root, Fixture fixture, string version)
    {
        var package = Path.Combine(root, "package-" + version + ".zip");
        CreatePackage(package, version);
        var bytes = File.ReadAllBytes(package);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var transactionId = version + "-" + Guid.NewGuid().ToString("N");
        var handoff = new UpdateHandoffBroker.HandoffPlan(
            transactionId,
            new Version(1, 7, 13),
            Version.Parse(version),
            "stable",
            package,
            hash,
            bytes.LongLength,
            "prepared-selector-selftest",
            fixture.InstallRoot,
            Path.Combine(root, transactionId + "-handoff.json"),
            DateTimeOffset.UtcNow,
            "prepared");
        var state = fixture.Journal.Begin(handoff);
        var plan = fixture.Protocol.Prepare(state);
        _ = fixture.Preparer.Prepare(plan);
        return new PreparedFixture(state, plan);
    }

    private static void CreatePackage(string path, string version)
    {
        var files = new Dictionary<string, byte[]>
        {
            ["SWIR.Desktop.Host.exe"] = Encoding.UTF8.GetBytes("FAKE-HOST-" + version),
            ["assets/runtime.txt"] = Encoding.UTF8.GetBytes("RUNTIME-" + version)
        };
        using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
        var manifestFiles = files.Select(pair => new CandidatePackagePreparer.PackageFile(
            pair.Key,
            Convert.ToHexString(SHA256.HashData(pair.Value)).ToLowerInvariant(),
            pair.Value.LongLength)).ToList();
        var manifest = new CandidatePackagePreparer.PackageManifest(
            CandidatePackagePreparer.PackageManifestSchema,
            version,
            "SWIR.Desktop.Host.exe",
            manifestFiles);
        var manifestEntry = archive.CreateEntry(CandidatePackagePreparer.ManifestEntryName, CompressionLevel.NoCompression);
        using (var writer = new StreamWriter(manifestEntry.Open(), new UTF8Encoding(false)))
            writer.Write(JsonSerializer.Serialize(manifest));
        foreach (var pair in files)
        {
            var entry = archive.CreateEntry(pair.Key, CompressionLevel.Fastest);
            using var stream = entry.Open();
            stream.Write(pair.Value);
        }
    }

    private static void ExpectCode(string code, Func<DesktopPreparedUpdateSelector.SelectedPreparedUpdate> action, string message)
    {
        try { _ = action(); }
        catch (UpdateSecurityException ex) when (ex.Code == code)
        {
            Expect(true, message);
            return;
        }
        throw new Exception($"Self-test failed: {message}; expected {code}.");
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new Exception("Self-test failed: " + message);
    }

    private sealed record Fixture(
        string TransactionsRoot,
        string DeploymentRoot,
        string InstallRoot,
        UpdateTransactionJournal Journal,
        UpdaterWorkerProtocol Protocol,
        CandidatePackagePreparer Preparer);

    private sealed record PreparedFixture(
        UpdateTransactionJournal.TransactionState State,
        UpdaterWorkerProtocol.WorkerPlan Plan);
}
