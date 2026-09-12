using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopReleaseToCandidateSelfTests
{
    private static int _passed;

    public static int Main(string[] args)
    {
        if (args.Length != 3)
        {
            Console.Error.WriteLine("Usage: SWIR.Desktop.ReleaseToCandidate.SelfTests <updater-worker-exe> <release-bundle-dir> <public-key-pem>");
            return 2;
        }

        var workerExe = Path.GetFullPath(args[0]);
        var bundleDir = Path.GetFullPath(args[1]);
        var publicKeyPath = Path.GetFullPath(args[2]);
        if (!File.Exists(workerExe) || !Directory.Exists(bundleDir) || !File.Exists(publicKeyPath))
        {
            Console.Error.WriteLine("Updater worker, release bundle, or public key is missing.");
            return 2;
        }

        try
        {
            Run(workerExe, bundleDir, File.ReadAllText(publicKeyPath));
            Console.WriteLine($"SWIR signed release -> Candidate E2E contract passed: {_passed}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("SWIR signed release -> Candidate E2E contract: FAIL");
            Console.Error.WriteLine(ex);
            return 1;
        }
    }

    private static void Run(string workerExe, string bundleDir, string publicKeyPem)
    {
        var targetVersion = new Version(0, 5, 2);
        const string channel = "preview";
        var verified = DesktopReleaseBundleVerifier.Verify(bundleDir, targetVersion, channel, publicKeyPem, new[] { "github.com" });
        Expect(verified.Schema == DesktopReleaseBundleVerifier.VerifierSchema, "release bundle passes independent signature/hash verification");
        Expect(verified.Version == targetVersion.ToString(), "verified release targets Desktop 0.5.2");
        Expect(verified.Channel == channel, "verified release remains bound to preview channel");

        var root = Path.Combine(Path.GetTempPath(), "swir-release-to-candidate-" + Guid.NewGuid().ToString("N"));
        var transactionsRoot = Path.Combine(root, "transactions");
        var deploymentRoot = Path.Combine(root, "deployment");
        var currentRoot = Path.Combine(deploymentRoot, "Current");
        Directory.CreateDirectory(currentRoot);
        File.WriteAllText(Path.Combine(currentRoot, "version.txt"), "0.5.1", Encoding.UTF8);

        try
        {
            var packagePath = Path.Combine(bundleDir, verified.PackageFile);
            var transactionId = "0.5.2-preview-e2e-" + Guid.NewGuid().ToString("N");
            var handoff = new UpdateHandoffBroker.HandoffPlan(
                transactionId,
                new Version(0, 5, 1),
                targetVersion,
                channel,
                packagePath,
                verified.PackageSha256,
                verified.PackageSize,
                verified.KeyId,
                currentRoot,
                Path.Combine(root, transactionId + "-handoff.json"),
                DateTimeOffset.UtcNow,
                "prepared");

            var journal = new UpdateTransactionJournal(transactionsRoot);
            var state = journal.Begin(handoff);
            Expect(state.TargetVersion == targetVersion, "transaction binds signed release target version");
            Expect(state.CurrentVersion == new Version(0, 5, 1), "transaction preserves known-good current version");

            var plan = RunWorker(workerExe, "plan", state.JournalPath, transactionsRoot, deploymentRoot);
            Expect(plan.ExitCode == 0, "standalone updater worker accepts signed release transaction");

            var prepare = RunWorker(workerExe, "prepare-candidate", state.JournalPath, transactionsRoot, deploymentRoot);
            Expect(prepare.ExitCode == 0, "standalone updater worker prepares Candidate from release ZIP");

            var candidateRoot = Path.Combine(deploymentRoot, "Candidate", transactionId);
            Expect(Directory.Exists(candidateRoot), "Candidate slot is created inside deployment sandbox");
            Expect(File.Exists(Path.Combine(candidateRoot, "SWIR.Desktop.Host.exe")), "shipping Desktop Host entry point is present in Candidate");
            Expect(File.Exists(Path.Combine(candidateRoot, CandidatePackagePreparer.CandidateStateFileName)), "Candidate verification state is persisted");
            Expect(File.ReadAllText(Path.Combine(currentRoot, "version.txt")).Trim() == "0.5.1", "preparation does not mutate Current before guarded activation");

            using var candidateState = JsonDocument.Parse(File.ReadAllText(Path.Combine(candidateRoot, CandidatePackagePreparer.CandidateStateFileName)));
            var rootElement = candidateState.RootElement;
            Expect(rootElement.GetProperty("Schema").GetString() == CandidatePackagePreparer.CandidateStateSchema, "Candidate state uses canonical schema");
            Expect(rootElement.GetProperty("Version").GetString() == "0.5.2", "Candidate state remains bound to signed release version");
            Expect(rootElement.GetProperty("Verified").GetBoolean(), "Candidate state records successful package verification");
        }
        finally
        {
            try { Directory.Delete(root, true); } catch { }
        }
    }

    private static ProcessResult RunWorker(string workerExe, string command, string journalPath, string transactionsRoot, string deploymentRoot)
    {
        var start = new ProcessStartInfo(workerExe)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        foreach (var arg in new[] { command, "--journal", journalPath, "--transactions-root", transactionsRoot, "--deployment-root", deploymentRoot })
            start.ArgumentList.Add(arg);

        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start standalone updater worker.");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(15000))
        {
            try { process.Kill(true); } catch { }
            throw new TimeoutException("Updater worker exceeded signed release Candidate preparation timeout.");
        }
        Task.WaitAll(stdout, stderr);
        if (process.ExitCode != 0)
            Console.Error.WriteLine(stderr.Result);
        return new ProcessResult(process.ExitCode, stdout.Result.Trim(), stderr.Result.Trim());
    }

    private static void Expect(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException("FAILED: " + name);
        _passed++;
        Console.WriteLine("PASS: " + name);
    }

    private sealed record ProcessResult(int ExitCode, string Stdout, string Stderr);
}
