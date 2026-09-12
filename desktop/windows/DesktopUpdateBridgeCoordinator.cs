namespace Swir.Desktop.Host;

/// <summary>
/// Fail-closed command gate for the trusted-shell WebView updates surface.
///
/// The critical invariant is that a mutating update restart is never executed while
/// the WebMessage request lease is still held. The bridge first calls PrepareApply()
/// while the request is authenticated, posts the acknowledgement, releases the lease,
/// and only then calls ExecuteQueuedAsync(). This prevents the restart lifecycle from
/// deadlocking while it drains in-flight native bridge requests.
/// </summary>
internal sealed class DesktopUpdateBridgeCoordinator
{
    public const string CoordinatorSchema = "swir.desktop-update-bridge/0.2";

    private readonly Func<object> _describeRestart;
    private readonly Action _verifyReady;
    private readonly Func<CancellationToken, Task> _executeRestartAsync;
    private int _state;

    public DesktopUpdateBridgeCoordinator(
        Func<object> describeRestart,
        Action verifyReady,
        Func<CancellationToken, Task> executeRestartAsync)
    {
        _describeRestart = describeRestart ?? throw new ArgumentNullException(nameof(describeRestart));
        _verifyReady = verifyReady ?? throw new ArgumentNullException(nameof(verifyReady));
        _executeRestartAsync = executeRestartAsync ?? throw new ArgumentNullException(nameof(executeRestartAsync));
    }

    public object Describe() => new
    {
        schema = CoordinatorSchema,
        commandState = StateName(Volatile.Read(ref _state)),
        requiresTrustedShell = true,
        executeAfterBridgeResponse = true,
        restart = _describeRestart()
    };

    /// <summary>
    /// Authenticated, read-only preflight. It reserves the single apply slot and then
    /// revalidates that exactly one prepared Candidate is still ready. No restart or
    /// slot mutation is allowed from this method.
    /// </summary>
    public ApplyRequestAcceptance PrepareApply(bool trustedShell)
    {
        if (!trustedShell)
            throw new DesktopUpdateBridgeCommandException(
                "UPDATE_BRIDGE_TRUST_REQUIRED",
                "Desktop update restart may only be requested by the trusted SWIR shell.");

        if (Interlocked.CompareExchange(ref _state, 1, 0) != 0)
            throw new DesktopUpdateBridgeCommandException(
                "UPDATE_RESTART_ALREADY_QUEUED",
                "A Desktop update restart request is already queued or in progress.");

        try
        {
            _verifyReady();
            return new ApplyRequestAcceptance(
                CoordinatorSchema,
                true,
                "queued",
                true,
                "Restart preflight passed. Execution is deferred until the bridge response lease is released.");
        }
        catch
        {
            Interlocked.Exchange(ref _state, 0);
            throw;
        }
    }

    /// <summary>
    /// Releases a queued request only if execution has not started. This is used when
    /// the host cannot deliver the acknowledgement to WebView; the updater must never
    /// mutate installation slots for a command whose bridge response was not delivered.
    /// </summary>
    public bool CancelQueuedAfterResponseFailure()
        => Interlocked.CompareExchange(ref _state, 0, 1) == 1;

    /// <summary>
    /// Must be called only after the WebMessage response has been posted and its bridge
    /// request lease disposed. A successful updater handoff remains latched for the life
    /// of this host process; a pre-handoff failure resets the gate so the user can retry.
    /// </summary>
    public async Task ExecuteQueuedAsync(CancellationToken cancellationToken = default)
    {
        if (Interlocked.CompareExchange(ref _state, 2, 1) != 1)
            throw new DesktopUpdateBridgeCommandException(
                "UPDATE_RESTART_NOT_QUEUED",
                "No prepared Desktop update restart request is queued for execution.");

        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            await _executeRestartAsync(cancellationToken).ConfigureAwait(false);
            Interlocked.Exchange(ref _state, 3);
        }
        catch
        {
            Interlocked.Exchange(ref _state, 0);
            throw;
        }
    }

    private static string StateName(int state) => state switch
    {
        0 => "idle",
        1 => "queued",
        2 => "running",
        3 => "handoff-requested",
        _ => "invalid"
    };

    internal sealed record ApplyRequestAcceptance(
        string Schema,
        bool Accepted,
        string State,
        bool ExecuteAfterBridgeResponse,
        string Message);
}

internal sealed class DesktopUpdateBridgeCommandException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
