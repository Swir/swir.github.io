namespace Swir.Desktop.Host;

/// <summary>
/// Reversible host-side preparation used immediately before the updater handoff.
/// The hooks deliberately know nothing about WebView2 so they can be failure-tested
/// without a browser process: MainWindow supplies UI-thread marshalled suspend/resume
/// callbacks, while this class enforces one-way preparation until an explicit resume.
/// </summary>
internal sealed class DesktopHostRestartHooks
{
    public const string HooksSchema = "swir.desktop-host-restart-hooks/0.1";

    private readonly Func<CancellationToken, Task> _suspendHostAsync;
    private readonly Func<CancellationToken, Task> _resumeHostAsync;
    private int _prepared;

    public DesktopHostRestartHooks(
        Func<CancellationToken, Task> suspendHostAsync,
        Func<CancellationToken, Task> resumeHostAsync)
    {
        _suspendHostAsync = suspendHostAsync ?? throw new ArgumentNullException(nameof(suspendHostAsync));
        _resumeHostAsync = resumeHostAsync ?? throw new ArgumentNullException(nameof(resumeHostAsync));
    }

    public bool IsPrepared => Volatile.Read(ref _prepared) != 0;

    public object Describe() => new
    {
        schema = HooksSchema,
        prepared = IsPrepared
    };

    public async Task PrepareAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (Interlocked.CompareExchange(ref _prepared, 1, 0) != 0)
            throw new UpdateSecurityException(
                "UPDATE_HOST_ALREADY_PREPARED",
                "Desktop host resources are already prepared for update restart.");

        try
        {
            await _suspendHostAsync(cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            Interlocked.Exchange(ref _prepared, 0);
            throw;
        }
    }

    public async Task ResumeAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (Volatile.Read(ref _prepared) == 0)
            return;

        await _resumeHostAsync(cancellationToken).ConfigureAwait(false);
        Interlocked.Exchange(ref _prepared, 0);
    }
}
