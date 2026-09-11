using System.Diagnostics;

namespace Swir.Desktop.Host;

/// <summary>
/// Creates a one-shot shutdown handoff and starts the standalone updater worker.
/// The caller remains responsible for closing the Desktop Host after this method
/// returns; the worker will not activate Current until that PID has actually exited.
/// </summary>
internal sealed class UpdateRestartLauncher
{
    public const string RestartSchema = "swir.desktop-update-restart/0.1";

    private readonly HostShutdownHandoff _shutdown;
    private readonly IUpdaterProcessStarter _starter;
    private readonly Func<int> _hostProcessId;

    public UpdateRestartLauncher(
        HostShutdownHandoff shutdown,
        IUpdaterProcessStarter? starter = null,
        Func<int>? hostProcessId = null)
    {
        _shutdown = shutdown ?? throw new ArgumentNullException(nameof(shutdown));
        _starter = starter ?? new SystemUpdaterProcessStarter();
        _hostProcessId = hostProcessId ?? (() => Environment.ProcessId);
    }

    public RestartLaunch Start(
        UpdateTransactionJournal.TransactionState state,
        string updaterWorkerPath,
        string transactionsRoot,
        string deploymentRoot,
        TimeSpan? ticketTtl = null)
    {
        ArgumentNullException.ThrowIfNull(state);
        var workerPath = Path.GetFullPath(updaterWorkerPath ?? string.Empty);
        if (string.IsNullOrWhiteSpace(updaterWorkerPath)
            || !string.Equals(Path.GetExtension(workerPath), ".exe", StringComparison.OrdinalIgnoreCase)
            || !File.Exists(workerPath))
            throw new UpdateSecurityException("UPDATE_RESTART_WORKER_INVALID", "Standalone updater worker executable is missing or invalid.");

        var transactionRoot = Path.GetFullPath(transactionsRoot ?? string.Empty);
        var deployment = Path.GetFullPath(deploymentRoot ?? string.Empty);
        if (!Directory.Exists(transactionRoot))
            throw new UpdateSecurityException("UPDATE_RESTART_TRANSACTIONS_ROOT_INVALID", "Updater transactions root does not exist.");
        if (!Directory.Exists(deployment))
            throw new UpdateSecurityException("UPDATE_RESTART_DEPLOYMENT_ROOT_INVALID", "Desktop deployment root does not exist.");

        var ttl = ticketTtl ?? TimeSpan.FromMinutes(2);
        var ticket = _shutdown.Issue(state, _hostProcessId(), ttl);
        var spec = new UpdaterProcessSpec(
            workerPath,
            Path.GetDirectoryName(workerPath) ?? deployment,
            new[]
            {
                "activate-and-launch",
                "--journal", state.JournalPath,
                "--transactions-root", transactionRoot,
                "--deployment-root", deployment
            },
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [HostShutdownHandoff.NonceEnvironmentVariable] = ticket.Nonce
            });

        try
        {
            var updaterProcessId = _starter.Start(spec);
            if (updaterProcessId <= 0)
                throw new UpdateSecurityException("UPDATE_RESTART_START_FAILED", "Updater worker returned an invalid process identifier.");

            return new RestartLaunch(
                RestartSchema,
                state.TransactionId,
                state.TargetVersion,
                ticket.HostProcessId,
                updaterProcessId,
                workerPath,
                ticket.TicketPath,
                ticket.ExpiresAt);
        }
        catch
        {
            // No updater acquired the ticket, so revoke it and allow a clean retry.
            try { if (File.Exists(ticket.TicketPath)) File.Delete(ticket.TicketPath); } catch { }
            throw;
        }
    }

    internal sealed record UpdaterProcessSpec(
        string FileName,
        string WorkingDirectory,
        IReadOnlyList<string> Arguments,
        IReadOnlyDictionary<string, string> Environment);

    internal interface IUpdaterProcessStarter
    {
        int Start(UpdaterProcessSpec spec);
    }

    private sealed class SystemUpdaterProcessStarter : IUpdaterProcessStarter
    {
        public int Start(UpdaterProcessSpec spec)
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = spec.FileName,
                WorkingDirectory = spec.WorkingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            foreach (var argument in spec.Arguments)
                startInfo.ArgumentList.Add(argument);
            foreach (var pair in spec.Environment)
                startInfo.Environment[pair.Key] = pair.Value;

            var process = Process.Start(startInfo)
                ?? throw new UpdateSecurityException("UPDATE_RESTART_START_FAILED", "Operating system did not start the updater worker.");
            var pid = process.Id;
            process.Dispose();
            return pid;
        }
    }

    internal sealed record RestartLaunch(
        string Schema,
        string TransactionId,
        Version TargetVersion,
        int HostProcessId,
        int UpdaterProcessId,
        string WorkerPath,
        string TicketPath,
        DateTimeOffset TicketExpiresAt);
}
