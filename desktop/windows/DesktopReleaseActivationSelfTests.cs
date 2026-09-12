using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopReleaseActivationSelfTests
{
    private static int _passed;

    public static int Main(string[] args)
    {
        if (args.Length != 3)
        {
            Console.Error.WriteLine("Usage: SWIR.Desktop.ReleaseActivation.SelfTests <updater-worker-exe> <release-bundle-dir> <public-key-pem>");
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
            Console.WriteLine($"SWIR signed release activation E2E passed: {_passed}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("SWIR signed release activation E2E: FAIL");
            Console.Error.WriteLine(ex);
            return 1;
        }
    }

    private static void Run(string workerExe, string bundleDir, string publicKeyPem)
    {
        var targetVersion = new Version(0, 5, 2);
        const string channel = "preview";
        var verified = DesktopReleaseBundleVerifier.Verify(bundleDir, targetVersion, channel, publicKeyPem, new[] { "github.com" });
        Expect(verified.Version == "0.5.2" && verified.Channel == channel, "signed release identity is verified before activation");

        var root = Path.Combine(Path.GetTempPath(), "swir-release-activation-" + Guid.NewGuid().ToString("N"));
        var transactionsRoot = Path.Combine(root, "transactions");
        var deploymentRoot = Path.Combine(root, "deployment");
        var currentRoot = Path.Combine(deploymentRoot, "Current");
        Directory.CreateDirectory(currentRoot);
        File.WriteAllText(Path.Combine(currentRoot, "version.txt"), "0.5.1", Encoding.UTF8);

        int? candidatePid = null;
        try
        {
            var packagePath = Path.Combine(bundleDir, verified.PackageFile);
            var transactionId = "0.5.2-preview-activation-" + Guid.NewGuid().ToString("N");
            var journal = new UpdateTransactionJournal(transactionsRoot);
            var state = journal.Begin(new UpdateHandoffBroker.HandoffPlan(
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
                "prepared"));

            Expect(RunWorker(workerExe, null, "plan", state.JournalPath, transactionsRoot, deploymentRoot).ExitCode == 0,
                "worker creates canonical activation plan for signed release");
            Expect(RunWorker(workerExe, null, "prepare-candidate", state.JournalPath, transactionsRoot, deploymentRoot).ExitCode == 0,
                "worker prepares verified Candidate from signed release");

            using var deadHost = Process.Start(new ProcessStartInfo("cmd.exe", "/d /c exit 0")
            {
                UseShellExecute = false,
                CreateNoWindow = true
            }) ?? throw new InvalidOperationException("Could not create completed host process for shutdown handoff.");
            deadHost.WaitForExit();

            var shutdown = new HostShutdownHandoff(journal, _ => false, _ => { }).Issue(state, deadHost.Id, TimeSpan.FromSeconds(30));
            var environment = new Dictionary<string, string?>
            {
                [HostShutdownHandoff.NonceEnvironmentVariable] = shutdown.Nonce
            };

            // Do not redirect updater stdout for the long-lived real Host launch. The Host can
            // inherit console handles from the worker on Windows, which would keep a redirected
            // pipe open after the worker itself exits. Canonical launch metadata is persisted in
            // launch.json and is the authoritative source for the candidate PID and identity.
            var activation = RunWorker(workerExe, environment, "activate-and-launch", state.JournalPath, transactionsRoot, deploymentRoot, 30000, captureOutput: false);
            Expect(activation.ExitCode == 0, "worker promotes and launches the real signed Desktop Host");

            var transactionDirectory = Path.GetDirectoryName(state.JournalPath)
                ?? throw new InvalidOperationException("Transaction directory is missing.");
            var launchPath = Path.Combine(transactionDirectory, "launch.json");
            WaitForFile(launchPath, TimeSpan.FromSeconds(5));
            using (var launchJson = JsonDocument.Parse(File.ReadAllText(launchPath)))
            {
                var rootElement = launchJson.RootElement;
                Expect(rootElement.GetProperty("Schema").GetString() == "swir.desktop-candidate-launch/0.1", "real release activation persists canonical launch schema");
                Expect(rootElement.GetProperty("TransactionId").GetString() == transactionId, "launch metadata remains bound to the signed release transaction");
                Expect(rootElement.GetProperty("TargetVersion").GetString() == "0.5.2", "launch metadata remains bound to target 0.5.2");
                candidatePid = rootElement.GetProperty("ProcessId").GetInt32();
                Expect(candidatePid > 0, "real Desktop Host process is created");
            }
            Expect(File.Exists(Path.Combine(transactionDirectory, "shutdown-consumed.json")),
                "one-shot host shutdown authorization is consumed before Candidate launch");

            var committed = WaitForState(journal, state.JournalPath, "committed", TimeSpan.FromSeconds(30));
            Expect(committed.TargetVersion == targetVersion, "real Desktop Host health proof commits target 0.5.2");

            var promotedManifestPath = Path.Combine(deploymentRoot, "Current", "desktop-host-build.json");
            Expect(File.Exists(promotedManifestPath), "committed Current contains Desktop Host build identity");
            using (var manifest = JsonDocument.Parse(File.ReadAllText(promotedManifestPath)))
            {
                var m = manifest.RootElement;
                Expect(m.GetProperty("hostVersion").GetString() == "0.5.2-preview", "promoted binary identity matches signed preview release");
                Expect(m.GetProperty("releaseVersion").GetString() == "0.5.2", "promoted binary release version matches signed manifest");
                Expect(m.GetProperty("channel").GetString() == channel, "promoted binary channel matches signed manifest");
            }

            var previousVersionPath = Path.Combine(deploymentRoot, "Previous", "version.txt");
            Expect(File.Exists(previousVersionPath) && File.ReadAllText(previousVersionPath).Trim() == "0.5.1",
                "known-good 0.5.1 deployment is retained in Previous after successful commit");
        }
        finally
        {
            if (candidatePid is > 0)
            {
                try
                {
                    using var process = Process.GetProcessById(candidatePid.Value);
                    if (!process.HasExited)
                    {
                        process.Kill(true);
                        process.WaitForExit(5000);
                    }
                }
                catch (ArgumentException) { }
                catch (InvalidOperationException) { }
            }
            try { Directory.Delete(root, true); } catch { }
        }
    }

    private static UpdateTransactionJournal.TransactionState WaitForState(
        UpdateTransactionJournal journal,
        string journalPath,
        string expected,
        TimeSpan timeout)
    {
        var watch = Stopwatch.StartNew();
        UpdateTransactionJournal.TransactionState state;
        do
        {
            state = journal.Read(journalPath);
            if (string.Equals(state.State, expected, StringComparison.Ordinal)) return state;
            if (string.Equals(state.State, "rolled-back", StringComparison.Ordinal)
                || string.Equals(state.State, "rollback-pending", StringComparison.Ordinal))
                throw new InvalidOperationException($"Candidate entered {state.State} instead of {expected}.");
            Thread.Sleep(100);
        } while (watch.Elapsed < timeout);
        throw new TimeoutException($"Transaction did not reach {expected}; final state was {state.State}.");
    }

    private static void WaitForFile(string path, TimeSpan timeout)
    {
        var watch = Stopwatch.StartNew();
        while (!File.Exists(path) && watch.Elapsed < timeout)
            Thread.Sleep(50);
        if (!File.Exists(path))
            throw new TimeoutException($"Expected activation metadata was not created: {path}");
    }

    private static ProcessResult RunWorker(
        string workerExe,
        IReadOnlyDictionary<string, string?>? environment,
        string command,
        string journalPath,
        string transactionsRoot,
        string deploymentRoot,
        int timeoutMs = 15000,
        bool captureOutput = true)
    {
        var start = new ProcessStartInfo(workerExe)
        {
            UseShellExecute = false,
            RedirectStandardOutput = captureOutput,
            RedirectStandardError = captureOutput,
            CreateNoWindow = true
        };
        foreach (var arg in new[] { command, "--journal", journalPath, "--transactions-root", transactionsRoot, "--deployment-root", deploymentRoot })
            start.ArgumentList.Add(arg);
        if (environment is not null)
            foreach (var pair in environment)
                start.Environment[pair.Key] = pair.Value;

        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start standalone updater worker.");
        Task<string>? stdout = captureOutput ? process.StandardOutput.ReadToEndAsync() : null;
        Task<string>? stderr = captureOutput ? process.StandardError.ReadToEndAsync() : null;
        if (!process.WaitForExit(timeoutMs))
        {
            try { process.Kill(true); } catch { }
            throw new TimeoutException($"Updater worker exceeded {timeoutMs}ms timeout during {command}.");
        }

        if (!captureOutput)
            return new ProcessResult(process.ExitCode, string.Empty, string.Empty);

        Task.WaitAll(stdout!, stderr!);
        if (process.ExitCode != 0) Console.Error.WriteLine(stderr!.Result);
        return new ProcessResult(process.ExitCode, stdout!.Result.Trim(), stderr!.Result.Trim());
    }

    private static void Expect(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException("FAILED: " + name);
        _passed++;
        Console.WriteLine("PASS: " + name);
    }

    private sealed record ProcessResult(int ExitCode, string Stdout, string Stderr);
}
