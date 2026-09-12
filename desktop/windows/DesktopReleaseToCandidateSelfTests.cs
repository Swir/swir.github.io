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
            var payloadRoot = Path.Combine(candidateRoot, "Payload");
            var candidateStatePath = Path.Combine(candidateRoot, "candidate-state.json");
            var hostBuildManifestPath = Path.Combine(payloadRoot, "desktop-host-build.json");
            Expect(Directory.Exists(candidateRoot), "Candidate slot is created inside deployment sandbox");
            Expect(File.Exists(Path.Combine(payloadRoot, "SWIR.Desktop.Host.exe")), "shipping Desktop Host entry point is present in Candidate payload");
            Expect(File.Exists(Path.Combine(payloadRoot, "SWIR.Desktop.UpdaterWorker.exe")), "standalone Updater Worker ships beside the Desktop Host");
            Expect(File.Exists(Path.Combine(payloadRoot, "desktop-update-policy.json")), "fail-closed Desktop update policy ships inside Candidate");
            Expect(File.Exists(Path.Combine(payloadRoot, "index.html")), "Web Edition shell ships inside the standalone Candidate");
            Expect(File.Exists(Path.Combine(payloadRoot, "swir-os.js")), "Web Edition OS runtime ships inside the standalone Candidate");
            Expect(File.Exists(Path.Combine(payloadRoot, "swir-runtime.js")), "portable Runtime Adapter ships inside the standalone Candidate");
            Expect(File.Exists(Path.Combine(payloadRoot, "swir-updates.html")), "Update Center UI ships inside the standalone Candidate");
            Expect(File.Exists(Path.Combine(payloadRoot, "desktop", "windows", "app-policy.json")), "Desktop permission policy ships with the Web runtime");
            var runtimeManifestPath = Path.Combine(payloadRoot, "desktop-runtime.json");
            Expect(File.Exists(runtimeManifestPath), "Desktop web runtime provenance manifest ships inside Candidate");
            Expect(File.Exists(hostBuildManifestPath), "Desktop Host build identity manifest ships inside Candidate");
            Expect(File.Exists(candidateStatePath), "Candidate verification state is persisted");
            Expect(File.ReadAllText(Path.Combine(currentRoot, "version.txt")).Trim() == "0.5.1", "preparation does not mutate Current before guarded activation");

            using (var hostBuildManifest = JsonDocument.Parse(File.ReadAllText(hostBuildManifestPath)))
            {
                var hostBuild = hostBuildManifest.RootElement;
                Expect(hostBuild.GetProperty("schema").GetString() == "swir.desktop-host-build/0.1", "Desktop Host build identity uses canonical schema");
                Expect(hostBuild.GetProperty("releaseVersion").GetString() == targetVersion.ToString(), "Desktop Host binary release identity matches signed target version");
                Expect(hostBuild.GetProperty("channel").GetString() == channel, "Desktop Host binary release identity matches signed channel");
                Expect(hostBuild.GetProperty("hostVersion").GetString() == "0.5.2-preview", "Desktop Host reports the same preview identity as the signed release");
                var sourceCommit = hostBuild.GetProperty("sourceCommit").GetString();
                Expect(!string.IsNullOrWhiteSpace(sourceCommit) && sourceCommit.Length == 40, "Desktop Host binary identity is bound to a Git source commit");
            }

            using (var runtimeManifest = JsonDocument.Parse(File.ReadAllText(runtimeManifestPath)))
            {
                Expect(runtimeManifest.RootElement.GetProperty("schema").GetString() == "swir.desktop-web-runtime/0.1", "bundled Web runtime keeps canonical provenance schema");
                Expect(runtimeManifest.RootElement.GetProperty("fileCount").GetInt32() >= 9, "bundled Web runtime contains required tracked assets");
                var commit = runtimeManifest.RootElement.GetProperty("sourceCommit").GetString();
                Expect(!string.IsNullOrWhiteSpace(commit) && commit.Length == 40, "bundled Web runtime is bound to a Git source commit");
            }

            using (var updatePolicy = JsonDocument.Parse(File.ReadAllText(Path.Combine(payloadRoot, "desktop-update-policy.json"))))
            {
                Expect(updatePolicy.RootElement.GetProperty("Schema").GetString() == "swir.desktop-update-policy/0.1", "packaged update policy keeps canonical schema");
                Expect(!updatePolicy.RootElement.GetProperty("Enabled").GetBoolean(), "packaged default update policy fails closed until a signed channel is configured");
            }

            using var candidateState = JsonDocument.Parse(File.ReadAllText(candidateStatePath));
            var rootElement = candidateState.RootElement;
            Expect(rootElement.GetProperty("Schema").GetString() == CandidatePackagePreparer.CandidateStateSchema, "Candidate state uses canonical schema");
            Expect(rootElement.GetProperty("TargetVersion").GetString() == "0.5.2", "Candidate state remains bound to signed release version");
            Expect(rootElement.GetProperty("PackageSha256").GetString() == verified.PackageSha256, "Candidate state remains bound to signed release package hash");
            Expect(rootElement.GetProperty("EntryPoint").GetString() == "SWIR.Desktop.Host.exe", "Candidate state keeps shipping Host as canonical entry point");
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
