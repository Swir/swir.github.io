namespace Swir.Desktop.Host;

/// <summary>
/// Admission/drain gate for native bridge calls during Desktop update restart.
/// Quiesce rejects new work and waits for all already-admitted requests to finish
/// before the updater handoff is allowed to start.
/// </summary>
internal sealed class DesktopBridgeDrainGate
{
    public const string GateSchema = "swir.desktop-bridge-drain/0.1";

    private readonly object _sync = new();
    private bool _accepting = true;
    private int _active;
    private TaskCompletionSource<bool>? _drained;

    public bool IsAccepting
    {
        get { lock (_sync) return _accepting; }
    }

    public int ActiveRequests
    {
        get { lock (_sync) return _active; }
    }

    public bool TryEnter(out IDisposable? lease)
    {
        lock (_sync)
        {
            if (!_accepting)
            {
                lease = null;
                return false;
            }

            checked { _active++; }
            lease = new Lease(this);
            return true;
        }
    }

    public async Task QuiesceAndDrainAsync(CancellationToken cancellationToken = default, TimeSpan? timeout = null)
    {
        Task wait;
        lock (_sync)
        {
            _accepting = false;
            if (_active == 0) return;
            _drained ??= new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            wait = _drained.Task;
        }

        await wait.WaitAsync(timeout ?? TimeSpan.FromSeconds(15), cancellationToken).ConfigureAwait(false);
    }

    public Task ResumeAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_sync)
        {
            if (_active != 0)
                throw new InvalidOperationException("Native bridge cannot resume while requests are still active.");
            _drained = null;
            _accepting = true;
        }
        return Task.CompletedTask;
    }

    public object Describe()
    {
        lock (_sync)
            return new { schema = GateSchema, accepting = _accepting, activeRequests = _active };
    }

    private void Exit()
    {
        TaskCompletionSource<bool>? signal = null;
        lock (_sync)
        {
            if (_active <= 0) throw new InvalidOperationException("Native bridge lease accounting underflow.");
            _active--;
            if (_active == 0 && !_accepting)
            {
                signal = _drained;
                _drained = null;
            }
        }
        signal?.TrySetResult(true);
    }

    private sealed class Lease : IDisposable
    {
        private DesktopBridgeDrainGate? _owner;
        public Lease(DesktopBridgeDrainGate owner) => _owner = owner;
        public void Dispose() => Interlocked.Exchange(ref _owner, null)?.Exit();
    }
}
