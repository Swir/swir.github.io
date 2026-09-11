using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Swir.Desktop.Host;

/// <summary>
/// Launches only the already-promoted Current desktop candidate and never persists
/// the raw health token. Any process-start failure or very early exit is converted
/// into a journal-driven rollback to Previous.
/// </summary>
internal sealed class ControlledCandidateLauncher
{
    public const string LaunchSchema = "swir.desktop-candidate-launch/0.1";
    public const string TransactionEnvironment = "SWIR_UPDATE_TRANSACTION_ID";
    public const string TargetVersionEnvironment = "SWIR_UPDATE_TARGET_VERSION";
    public const string HealthTokenEnvironment = "SWIR_UPDATE_HEALTH_TOKEN";
    public const string JournalEnvironment = "SWIR_UPDATE_JOURNAL";

    private static readonly TimeSpan DefaultStartupProbe = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan MaxStartupProbe = TimeSpan.FromSeconds(10);

    private readonly UpdateTransactionJournal _journal;
    private readonly DeploymentSlotActivator _activator;
    private readonly ICandidateProcessStarter _starter;
    private readonly Func<DateTimeOffset> _clock;

    public ControlledCandidateLauncher(
        UpdateTransactionJournal journal,
        DeploymentSlotActivator activator,
        ICandidateProcessStarter? starter = null,
        Func<DateTimeOffset>? clock = null)
    {
        _journal = journal ?? throw new ArgumentNullException(nameof(journal));
        _activator = activator ?? throw new ArgumentNullException(nameof(activator));
        _starter = starter ?? new SystemCandidateProcessStarter();
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public LaunchState Launch(
        UpdaterWorkerProtocol.WorkerPlan plan,
        CandidatePackagePreparer.CandidateState candidate,
        UpdateActivationCoordinator.ActivationReady ready,
        TimeSpan? startupProbe = null)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(candidate);
        ArgumentNullException.ThrowIfNull(ready);

        var probe = startupProbe ?? DefaultStartupProbe;
        if (probe < TimeSpan.Zero || probe > MaxStartupProbe)
            throw new UpdateSecurityException("UPDATE_LAUNCH_PROBE_INVALID", "Candidate startup probe is outside the allowed range.");

        var canonical = ReadCanonical(plan);
        if (!string.Equals(canonical.State, "awaiting-health-check", StringComparison.Ordinal)
            || !string.Equals(canonical.TransactionId, ready.TransactionId, StringComparison.Ordinal)
            || canonical.TargetVersion != ready.TargetVersion
            || !string.Equals(candidate.TransactionId, canonical.TransactionId, StringComparison.Ordinal)
            || !Version.TryParse(candidate.TargetVersion, out var candidateVersion)
            || candidateVersion != canonical.TargetVersion)
            throw new UpdateSecurityException("UPDATE_LAUNCH_STATE_INVALID", "Candidate launch is not bound to the active awaiting-health-check transaction.");

        var activation = _activator.Read(plan);
        if (!string.Equals(activation.Phase, "awaiting-health-check", StringComparison.Ordinal)
            || !string.Equals(activation.TransactionId, canonical.TransactionId, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_LAUNCH_ACTIVATION_INVALID", "Candidate activation checkpoint is not ready for launch.");

        var currentRoot = Path.GetFullPath(plan.CurrentRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (!Directory.Exists(currentRoot))
            throw new UpdateSecurityException("UPDATE_LAUNCH_CURRENT_MISSING", "Current deployment slot is missing.");

        var entryRelative = NormalizeEntryPoint(candidate.EntryPoint);
        var entryPoint = Path.GetFullPath(Path.Combine(currentRoot, entryRelative.Replace('/', Path.DirectorySeparatorChar)));
        EnsureChild(currentRoot, entryPoint);
        if (!File.Exists(entryPoint))
            throw new UpdateSecurityException("UPDATE_LAUNCH_ENTRYPOINT_MISSING", "Promoted candidate entry point is missing.");
        if (!string.Equals(Path.GetExtension(entryPoint), ".exe", StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException("UPDATE_LAUNCH_ENTRYPOINT_INVALID", "Windows Desktop candidate entry point must be an executable.");

        var launchPath = LaunchPath(canonical.JournalPath);
        if (File.Exists(launchPath))
            throw new UpdateSecurityException("UPDATE_LAUNCH_ALREADY_STARTED", "Candidate launch metadata already exists for this transaction.");

        var spec = new CandidateProcessSpec(
            entryPoint,
            currentRoot,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [TransactionEnvironment] = canonical.TransactionId,
                [TargetVersionEnvironment] = canonical.TargetVersion.ToString(),
                [HealthTokenEnvironment] = ready.HealthChallenge.Token,
                [JournalEnvironment] = canonical.JournalPath
            });

        ICandidateProcessHandle? process = null;
        try
        {
            process = _starter.Start(spec)
                ?? throw new UpdateSecurityException("UPDATE_LAUNCH_START_FAILED", "Candidate process starter returned no process handle.");
            if (process.Id <= 0)
                throw new UpdateSecurityException("UPDATE_LAUNCH_START_FAILED", "Candidate process returned an invalid process identifier.");

            var startedAt = _clock();
            var state = new LaunchState(
                LaunchSchema,
                canonical.TransactionId,
                canonical.TargetVersion.ToString(),
                process.Id,
                entryRelative,
                startedAt,
                "started",
                launchPath);
            AtomicWrite(launchPath, state);

            if (probe > TimeSpan.Zero && process.WaitForExit(probe))
            {
                var exitCode = process.ExitCode;
                RollbackAfterLaunchFailure(plan, canonical);
                var failed = state with { Phase = "early-exit", ExitCode = exitCode, UpdatedAt = _clock() };
                AtomicWrite(launchPath, failed);
                throw new UpdateSecurityException("UPDATE_LAUNCH_EARLY_EXIT", $"Candidate process exited during startup probe with code {exitCode?.ToString() ?? "unknown"}.");
            }

            return state;
        }
        catch (UpdateSecurityException ex) when (ex.Code == "UPDATE_LAUNCH_EARLY_EXIT")
        {
            // Rollback and diagnostics were already completed above. Preserve the
            // precise early-exit signal instead of wrapping it as a start failure.
            throw;
        }
        catch (UpdateSecurityException ex)
        {
            TryRollbackAfterStartFailure(plan, canonical, ex);
            throw;
        }
        catch (Exception ex)
        {
            TryRollbackAfterStartFailure(plan, canonical, ex);
            throw new UpdateSecurityException("UPDATE_LAUNCH_START_FAILED", $"Candidate process could not be started safely: {ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            process?.Dispose();
        }
    }

    private void TryRollbackAfterStartFailure(UpdaterWorkerProtocol.WorkerPlan plan, UpdateTransactionJournal.TransactionState original, Exception launchError)
    {
        try
        {
            var canonical = _journal.Read(original.JournalPath);
            if (string.Equals(canonical.State, "awaiting-health-check", StringComparison.Ordinal))
                RollbackAfterLaunchFailure(plan, canonical);
        }
        catch (Exception rollbackError)
        {
            throw new UpdateSecurityException(
                "UPDATE_LAUNCH_ROLLBACK_FAILED",
                $"Candidate launch failed and Previous could not be restored. Launch error: {launchError.Message}; rollback error: {rollbackError.Message}");
        }
    }

    private void RollbackAfterLaunchFailure(UpdaterWorkerProtocol.WorkerPlan plan, UpdateTransactionJournal.TransactionState canonical)
    {
        var pending = _journal.Transition(canonical, "rollback-pending");
        if (!string.Equals(pending.State, "rollback-pending", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_LAUNCH_ROLLBACK_FAILED", "Transaction did not enter rollback-pending.");
        var restored = _activator.Rollback(plan);
        if (!string.Equals(restored.State, "rolled-back", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_LAUNCH_ROLLBACK_FAILED", "Previous deployment was not restored after launch failure.");
    }

    private UpdateTransactionJournal.TransactionState ReadCanonical(UpdaterWorkerProtocol.WorkerPlan plan)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(plan.PlanPath))
            ?? throw new UpdateSecurityException("UPDATE_LAUNCH_PATH_INVALID", "Worker plan directory is invalid.");
        var state = _journal.Read(Path.Combine(directory, "transaction.json"));
        if (!string.Equals(state.TransactionId, plan.TransactionId, StringComparison.Ordinal)
            || state.CurrentVersion != plan.CurrentVersion
            || state.TargetVersion != plan.TargetVersion)
            throw new UpdateSecurityException("UPDATE_LAUNCH_PLAN_MISMATCH", "Worker plan is not bound to the canonical transaction.");
        return state;
    }

    private static string NormalizeEntryPoint(string? value)
    {
        var path = (value ?? string.Empty).Replace('\\', '/').Trim('/');
        if (string.IsNullOrWhiteSpace(path) || Path.IsPathRooted(path) || path.Contains(':'))
            throw new UpdateSecurityException("UPDATE_LAUNCH_ENTRYPOINT_INVALID", "Candidate entry point is invalid.");
        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0 || segments.Any(segment => segment is "." or ".." || string.IsNullOrWhiteSpace(segment)))
            throw new UpdateSecurityException("UPDATE_LAUNCH_ENTRYPOINT_INVALID", "Candidate entry point escapes the deployment root.");
        return string.Join('/', segments);
    }

    private static void EnsureChild(string root, string path)
    {
        var prefix = root + Path.DirectorySeparatorChar;
        if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException("UPDATE_LAUNCH_ENTRYPOINT_INVALID", "Candidate entry point escaped Current deployment root.");
    }

    private static string LaunchPath(string journalPath)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(journalPath))
            ?? throw new UpdateSecurityException("UPDATE_LAUNCH_PATH_INVALID", "Transaction journal directory is invalid.");
        return Path.Combine(directory, "launch.json");
    }

    private static void AtomicWrite(string path, LaunchState state)
    {
        var directory = Path.GetDirectoryName(path)
            ?? throw new UpdateSecurityException("UPDATE_LAUNCH_PATH_INVALID", "Launch metadata directory is invalid.");
        Directory.CreateDirectory(directory);
        var tempPath = Path.Combine(directory, $".launch-{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllText(tempPath, JsonSerializer.Serialize(state, JsonOptions), Encoding.UTF8);
            File.Move(tempPath, path, true);
        }
        catch
        {
            try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { }
            throw;
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = false, WriteIndented = true };

    internal sealed record CandidateProcessSpec(string FileName, string WorkingDirectory, IReadOnlyDictionary<string, string> Environment);

    internal interface ICandidateProcessStarter
    {
        ICandidateProcessHandle Start(CandidateProcessSpec spec);
    }

    internal interface ICandidateProcessHandle : IDisposable
    {
        int Id { get; }
        int? ExitCode { get; }
        bool WaitForExit(TimeSpan timeout);
    }

    private sealed class SystemCandidateProcessStarter : ICandidateProcessStarter
    {
        public ICandidateProcessHandle Start(CandidateProcessSpec spec)
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = spec.FileName,
                WorkingDirectory = spec.WorkingDirectory,
                UseShellExecute = false,
                CreateNoWindow = false
            };
            foreach (var pair in spec.Environment)
                startInfo.Environment[pair.Key] = pair.Value;
            var process = Process.Start(startInfo)
                ?? throw new UpdateSecurityException("UPDATE_LAUNCH_START_FAILED", "Operating system did not create the candidate process.");
            return new SystemCandidateProcessHandle(process);
        }
    }

    private sealed class SystemCandidateProcessHandle : ICandidateProcessHandle
    {
        private readonly Process _process;
        public SystemCandidateProcessHandle(Process process) => _process = process;
        public int Id => _process.Id;
        public int? ExitCode => _process.HasExited ? _process.ExitCode : null;
        public bool WaitForExit(TimeSpan timeout) => _process.WaitForExit((int)Math.Min(int.MaxValue, Math.Ceiling(timeout.TotalMilliseconds)));
        public void Dispose() => _process.Dispose();
    }

    internal sealed record LaunchState(
        string Schema,
        string TransactionId,
        string TargetVersion,
        int ProcessId,
        string EntryPoint,
        DateTimeOffset StartedAt,
        string Phase,
        string LaunchPath,
        int? ExitCode = null,
        DateTimeOffset? UpdatedAt = null);
}
