namespace Swir.Desktop.Host;

internal sealed class DesktopUpdatePreparationBridgeCoordinator
{
    private readonly object _gate = new();
    private readonly Func<bool> _isConfigured;
    private readonly Func<CancellationToken, Task<object?>> _prepareAsync;
    private string _state = "idle";
    private string? _operationId;
    private object? _lastResult;
    private BridgeFailure? _lastFailure;

    public DesktopUpdatePreparationBridgeCoordinator(
        Func<bool> isConfigured,
        Func<CancellationToken, Task<object?>> prepareAsync)
    {
        _isConfigured = isConfigured ?? throw new ArgumentNullException(nameof(isConfigured));
        _prepareAsync = prepareAsync ?? throw new ArgumentNullException(nameof(prepareAsync));
    }

    public object Describe()
    {
        lock (_gate)
        {
            return new
            {
                schema = "swir.desktop-update-preparation-bridge/0.1",
                configured = SafeConfigured(),
                state = _state,
                operationId = _operationId,
                lastResult = _lastResult,
                lastFailure = _lastFailure,
                singleFlight = true,
                trustedShellOnly = true
            };
        }
    }

    public object QueuePrepare(bool trustedShell)
    {
        if (!trustedShell)
            throw new DesktopUpdateBridgeCommandException("UPDATE_BRIDGE_TRUST_REQUIRED", "Only the trusted SWIR system shell may prepare Desktop updates.");

        lock (_gate)
        {
            if (!SafeConfigured())
                throw new DesktopUpdateBridgeCommandException("UPDATE_RELEASE_FEED_NOT_CONFIGURED", "Desktop release feed policy is not enabled and fully configured.");
            if (_state is "queued" or "running")
                throw new DesktopUpdateBridgeCommandException("UPDATE_PREPARATION_ALREADY_RUNNING", "A Desktop update preparation operation is already active.");

            _state = "queued";
            _operationId = Guid.NewGuid().ToString("N");
            _lastFailure = null;
            return new { accepted = true, state = _state, operationId = _operationId, message = "Update preparation queued after bridge acknowledgement." };
        }
    }

    public void CancelQueuedAfterResponseFailure()
    {
        lock (_gate)
        {
            if (_state != "queued") return;
            _state = "idle";
            _operationId = null;
        }
    }

    public async Task<object?> ExecuteQueuedAsync(CancellationToken cancellationToken = default)
    {
        string operationId;
        lock (_gate)
        {
            if (_state != "queued" || string.IsNullOrWhiteSpace(_operationId))
                throw new DesktopUpdateBridgeCommandException("UPDATE_PREPARATION_NOT_QUEUED", "No acknowledged Desktop update preparation operation is queued.");
            _state = "running";
            operationId = _operationId;
        }

        try
        {
            var result = await _prepareAsync(cancellationToken).ConfigureAwait(false);
            lock (_gate)
            {
                if (!string.Equals(_operationId, operationId, StringComparison.Ordinal))
                    throw new DesktopUpdateBridgeCommandException("UPDATE_PREPARATION_OPERATION_MISMATCH", "Desktop update preparation operation identity changed unexpectedly.");
                _lastResult = result;
                _lastFailure = null;
                _state = "ready";
            }
            return result;
        }
        catch (OperationCanceledException)
        {
            lock (_gate)
            {
                if (string.Equals(_operationId, operationId, StringComparison.Ordinal))
                {
                    _state = "idle";
                    _operationId = null;
                    _lastFailure = new BridgeFailure("UPDATE_PREPARATION_CANCELLED", "Desktop update preparation was cancelled.");
                }
            }
            throw;
        }
        catch (Exception ex)
        {
            var code = ex switch
            {
                DesktopUpdateBridgeCommandException bridge => bridge.Code,
                UpdateSecurityException security => security.Code,
                _ => "UPDATE_PREPARATION_FAILED"
            };
            lock (_gate)
            {
                if (string.Equals(_operationId, operationId, StringComparison.Ordinal))
                {
                    _state = "failed";
                    _lastFailure = new BridgeFailure(code, ex.Message);
                }
            }
            throw;
        }
    }

    public void ResetTerminalState()
    {
        lock (_gate)
        {
            if (_state is "queued" or "running")
                throw new DesktopUpdateBridgeCommandException("UPDATE_PREPARATION_BUSY", "Active Desktop update preparation cannot be reset.");
            _state = "idle";
            _operationId = null;
            _lastResult = null;
            _lastFailure = null;
        }
    }

    private bool SafeConfigured()
    {
        try { return _isConfigured(); }
        catch { return false; }
    }

    internal sealed record BridgeFailure(string Code, string Message);
}
