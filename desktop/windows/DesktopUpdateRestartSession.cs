namespace Swir.Desktop.Host;

/// <summary>
/// Binds the update restart lifecycle to the native bridge drain gate. MainWindow can
/// admit every native request through this session and use RestartAsync to guarantee
/// that no in-flight bridge work is abandoned before the updater handoff starts.
/// </summary>
internal sealed class DesktopUpdateRestartSession
{
    public const string SessionSchema = "swir.desktop-update-restart-session/0.1";

    private readonly DesktopBridgeDrainGate _bridgeGate;
    private readonly RestartExecutor _restart;

    public DesktopUpdateRestartSession(
        DesktopUpdateRestartLifecycle lifecycle,
        DesktopBridgeDrainGate? bridgeGate = null)
        : this(
            bridgeGate ?? new DesktopBridgeDrainGate(),
            (state, quiesce, prepare, exit, resume, cancellationToken) =>
                lifecycle.RestartCanonicalAsync(
                    state,
                    quiesce,
                    prepare,
                    exit,
                    resume,
                    cancellationToken: cancellationToken))
    {
        ArgumentNullException.ThrowIfNull(lifecycle);
    }

    internal DesktopUpdateRestartSession(DesktopBridgeDrainGate bridgeGate, RestartExecutor restart)
    {
        _bridgeGate = bridgeGate ?? throw new ArgumentNullException(nameof(bridgeGate));
        _restart = restart ?? throw new ArgumentNullException(nameof(restart));
    }

    public bool TryEnterBridgeRequest(out IDisposable? lease) => _bridgeGate.TryEnter(out lease);

    public object Describe() => new
    {
        schema = SessionSchema,
        bridge = _bridgeGate.Describe()
    };

    public Task<DesktopUpdateRestartLifecycle.RestartLifecycleResult> RestartAsync(
        UpdateTransactionJournal.TransactionState state,
        Func<CancellationToken, Task> prepareHostForExitAsync,
        Action requestHostExit,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(prepareHostForExitAsync);
        ArgumentNullException.ThrowIfNull(requestHostExit);

        return _restart(
            state,
            cancellationToken => _bridgeGate.QuiesceAndDrainAsync(cancellationToken),
            prepareHostForExitAsync,
            requestHostExit,
            cancellationToken => _bridgeGate.ResumeAsync(cancellationToken),
            cancellationToken);
    }

    internal delegate Task<DesktopUpdateRestartLifecycle.RestartLifecycleResult> RestartExecutor(
        UpdateTransactionJournal.TransactionState state,
        Func<CancellationToken, Task> quiesceAsync,
        Func<CancellationToken, Task> prepareForExitAsync,
        Action requestHostExit,
        Func<CancellationToken, Task> resumeAfterFailureAsync,
        CancellationToken cancellationToken);
}
