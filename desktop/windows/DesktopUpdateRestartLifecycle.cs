namespace Swir.Desktop.Host;

/// <summary>
/// Coordinates the in-process side of Apply update & restart without exposing update
/// execution directly to WebView applications. The lifecycle is intentionally narrow:
/// quiesce new bridge work, prepare/flush host resources, start the guarded updater
/// handoff, then request process exit. If anything fails before the updater starts,
/// the host can resume service and retry safely.
/// </summary>
internal sealed class DesktopUpdateRestartLifecycle
{
    public const string LifecycleSchema = "swir.desktop-update-restart-lifecycle/0.1";

    private readonly UpdateRestartLauncher _launcher;
    private int _inProgress;

    public DesktopUpdateRestartLifecycle(UpdateRestartLauncher launcher)
        => _launcher = launcher ?? throw new ArgumentNullException(nameof(launcher));

    public bool IsRestartInProgress => Volatile.Read(ref _inProgress) != 0;

    /// <summary>
    /// Production entry point. The host never accepts deployment/update roots from
    /// WebView or mutable transaction metadata; it uses DesktopUpdatePaths only.
    /// </summary>
    public Task<RestartLifecycleResult> RestartCanonicalAsync(
        UpdateTransactionJournal.TransactionState state,
        Func<CancellationToken, Task> quiesceAsync,
        Func<CancellationToken, Task> prepareForExitAsync,
        Action requestHostExit,
        Func<CancellationToken, Task>? resumeAfterFailureAsync = null,
        TimeSpan? ticketTtl = null,
        CancellationToken cancellationToken = default)
        => RestartAsync(
            state,
            DesktopUpdatePaths.UpdaterWorkerPath,
            DesktopUpdatePaths.TransactionsRoot,
            DesktopUpdatePaths.DeploymentRoot,
            quiesceAsync,
            prepareForExitAsync,
            requestHostExit,
            resumeAfterFailureAsync,
            ticketTtl,
            cancellationToken);

    internal async Task<RestartLifecycleResult> RestartAsync(
        UpdateTransactionJournal.TransactionState state,
        string updaterWorkerPath,
        string transactionsRoot,
        string deploymentRoot,
        Func<CancellationToken, Task> quiesceAsync,
        Func<CancellationToken, Task> prepareForExitAsync,
        Action requestHostExit,
        Func<CancellationToken, Task>? resumeAfterFailureAsync = null,
        TimeSpan? ticketTtl = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(quiesceAsync);
        ArgumentNullException.ThrowIfNull(prepareForExitAsync);
        ArgumentNullException.ThrowIfNull(requestHostExit);

        if (Interlocked.CompareExchange(ref _inProgress, 1, 0) != 0)
            throw new UpdateSecurityException(
                "UPDATE_RESTART_ALREADY_IN_PROGRESS",
                "A Desktop update restart is already in progress for this host process.");

        var quiesced = false;
        var workerStarted = false;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            await quiesceAsync(cancellationToken).ConfigureAwait(false);
            quiesced = true;

            cancellationToken.ThrowIfCancellationRequested();
            await prepareForExitAsync(cancellationToken).ConfigureAwait(false);

            cancellationToken.ThrowIfCancellationRequested();
            var launch = _launcher.Start(
                state,
                updaterWorkerPath,
                transactionsRoot,
                deploymentRoot,
                ticketTtl);
            workerStarted = true;

            // From this point forward the worker owns the guarded handoff. Do not
            // reopen bridge traffic if exit signalling fails: the worker will time
            // out rather than mutating Current while this PID is still alive.
            requestHostExit();

            return new RestartLifecycleResult(
                LifecycleSchema,
                launch.TransactionId,
                launch.TargetVersion,
                launch.HostProcessId,
                launch.UpdaterProcessId,
                launch.WorkerPath,
                launch.TicketPath,
                launch.TicketExpiresAt,
                true,
                true);
        }
        catch
        {
            if (!workerStarted)
            {
                if (quiesced && resumeAfterFailureAsync is not null)
                {
                    try { await resumeAfterFailureAsync(CancellationToken.None).ConfigureAwait(false); }
                    catch { /* preserve the original restart failure */ }
                }
                Interlocked.Exchange(ref _inProgress, 0);
            }
            throw;
        }
    }

    internal sealed record RestartLifecycleResult(
        string Schema,
        string TransactionId,
        Version TargetVersion,
        int HostProcessId,
        int UpdaterProcessId,
        string WorkerPath,
        string TicketPath,
        DateTimeOffset TicketExpiresAt,
        bool BridgeQuiesced,
        bool HostExitRequested);
}
