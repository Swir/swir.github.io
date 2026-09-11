namespace Swir.Desktop.Host;

/// <summary>
/// Production-facing composition root for the final MainWindow update-restart hook.
/// It exposes read-only readiness diagnostics and only starts a restart after the
/// selector has revalidated exactly one prepared Candidate against its canonical
/// journal and worker plan.
/// </summary>
internal sealed class DesktopUpdateRestartController
{
    public const string ControllerSchema = "swir.desktop-update-restart-controller/0.1";

    private readonly DesktopPreparedUpdateSelector _selector;
    private readonly DesktopUpdateRestartSession _session;

    public DesktopUpdateRestartController(
        DesktopPreparedUpdateSelector selector,
        DesktopUpdateRestartSession session)
    {
        _selector = selector ?? throw new ArgumentNullException(nameof(selector));
        _session = session ?? throw new ArgumentNullException(nameof(session));
    }

    public object Describe() => new
    {
        schema = ControllerSchema,
        preparedUpdate = _selector.Inspect(),
        restartSession = _session.Describe()
    };

    public Task<DesktopUpdateRestartLifecycle.RestartLifecycleResult> RestartReadyAsync(
        Func<CancellationToken, Task> prepareHostForExitAsync,
        Action requestHostExit,
        Func<CancellationToken, Task>? resumeHostAfterFailureAsync = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(prepareHostForExitAsync);
        ArgumentNullException.ThrowIfNull(requestHostExit);

        var selected = _selector.RequireReady();
        return _session.RestartAsync(
            selected.State,
            prepareHostForExitAsync,
            requestHostExit,
            resumeHostAfterFailureAsync,
            cancellationToken);
    }
}
