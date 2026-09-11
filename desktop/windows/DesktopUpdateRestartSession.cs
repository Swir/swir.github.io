namespace Swir.Desktop.Host;

/// <summary>
/// Binds the update restart lifecycle to the native bridge drain gate. MainWindow can
/// admit every native request through this session and use RestartAsync to guarantee
/// that no in-flight bridge work is abandoned before the updater handoff starts.
/// </summary>
internal sealed class DesktopUpdateRestartSession
{
    public const string SessionSchema = "swir.desktop-update-restart-session/0.2";

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
        Func<CancellationToken, Task>? resumeHostAfterFailureAsync = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(prepareHostForExitAsync);
        ArgumentNullException.ThrowIfNull(requestHostExit);

        async Task ResumeAsync(CancellationToken token)
        {
            // The host must be operational again before bridge admission is reopened,
            // otherwise a retrying WebView request could race partially-restored UI state.
            if (resumeHostAfterFailureAsync is not null)
                await resumeHostAfterFailureAsync(token).ConfigureAwait(false);
            await _bridgeGate.ResumeAsync(token).ConfigureAwait(false);
        }

        return _restart(
            state,
            token => _bridgeGate.QuiesceAndDrainAsync(token),
            prepareHostForExitAsync,
            requestHostExit,
            ResumeAsync,
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
