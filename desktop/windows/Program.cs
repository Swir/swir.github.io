using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Swir.Desktop.Host;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainWindow(args));
    }
}

internal sealed class MainWindow : Form
{
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly CapabilityBroker _capabilities = new();
    private readonly AppDataBroker _appData = new();
    private readonly DesktopDeviceNetworkBroker _deviceNetwork = new();
    private readonly DesktopProcessServiceBroker _processServices = new();
    private readonly DesktopTrayLifecycle _trayLifecycle = new();
    private readonly DesktopAccountSessionBroker _identity;
    private readonly PermissionBroker _permissions;
    private readonly ExecutionPolicyCatalog _policyCatalog;
    private readonly AppIsolationRegistry _isolation;
    private readonly StartupHealthHandshake? _startupHealth;
    private readonly DesktopStartupRecovery _startupRecovery;
    private readonly DesktopUpdateRestartSession _restartSession;
    private readonly DesktopUpdateRestartController _updateRestartController;
    private readonly DesktopHostRestartHooks _restartHooks;
    private readonly DesktopUpdateBridgeCoordinator _updateBridgeCoordinator;
    private readonly DesktopUpdatePreparationHostService _updatePreparationHost;
    private readonly NativeFileSystemBroker _nativeFileSystem;
    private readonly DesktopPackageBridge _packages;
    private readonly DesktopTrayIcon _tray;
    private readonly DesktopNotificationBridgeService _notifications;
    private readonly DesktopShellIntegrationCoordinator _shellIntegration;
    private readonly string[] _startupArguments;
    private readonly string _repoRoot;
    private readonly string _dataRoot;
    private CoreWebView2? _core;
    private bool _bridgeAttached;
    private string? _shellAssociationWarning;

    public MainWindow(IEnumerable<string>? startupArguments = null)
    {
        _startupArguments = (startupArguments ?? Array.Empty<string>()).ToArray();
        Text = "SWIR OS Desktop Edition Preview";
        Width = 1440;
        Height = 900;
        MinimumSize = new Size(1024, 700);
        StartPosition = FormStartPosition.CenterScreen;
        _startupHealth = StartupHealthHandshake.CaptureFromEnvironment();
        _startupRecovery = new DesktopStartupRecovery();

        var updateJournal = new UpdateTransactionJournal(DesktopUpdatePaths.TransactionsRoot);
        var restartLauncher = new UpdateRestartLauncher(new HostShutdownHandoff(updateJournal));
        var restartLifecycle = new DesktopUpdateRestartLifecycle(restartLauncher);
        _restartSession = new DesktopUpdateRestartSession(restartLifecycle);
        var updateSelector = new DesktopPreparedUpdateSelector(updateJournal);
        _updateRestartController = new DesktopUpdateRestartController(updateSelector, _restartSession);
        _restartHooks = new DesktopHostRestartHooks(
            SuspendHostForUpdateRestartAsync,
            ResumeHostAfterUpdateRestartFailureAsync);
        _updateBridgeCoordinator = new DesktopUpdateBridgeCoordinator(
            DescribeUpdateRestartReadiness,
            () => { _ = updateSelector.RequireReady(); },
            async cancellationToken => { _ = await ApplyPreparedUpdateAndRestartAsync(cancellationToken).ConfigureAwait(false); });
        _updatePreparationHost = new DesktopUpdatePreparationHostService();

        _repoRoot = ResolveRepoRoot();
        _policyCatalog = new ExecutionPolicyCatalog(Path.Combine(_repoRoot, "desktop", "windows", "app-policy.json"));
        _isolation = new AppIsolationRegistry(_policyCatalog);
        _permissions = new PermissionBroker(_capabilities, _policyCatalog);
        _identity = new DesktopAccountSessionBroker(_capabilities.SessionId);
        _dataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SWIR", "DesktopHost", "Data");
        Directory.CreateDirectory(_dataRoot);
        _nativeFileSystem = new NativeFileSystemBroker(_dataRoot);
        _packages = new DesktopPackageBridge(_capabilities, new DesktopAppPackageInstaller(_dataRoot));
        _shellIntegration = new DesktopShellIntegrationCoordinator(Application.ExecutablePath, _capabilities.RegisterFile);
        Controls.Add(_web);
        _tray = new DesktopTrayIcon(this, _trayLifecycle);
        _notifications = DesktopNotificationHostBinding.Create(_permissions, _tray);
        Shown += async (_, _) => await StartAsync();
        Resize += OnHostResize;
        FormClosing += OnHostFormClosing;
        FormClosed += (_, _) =>
        {
            DetachBridge();
            _shellIntegration.Dispose();
            _tray.Dispose();
        };
    }

    private async Task StartAsync()
    {
        try
        {
            _startupRecovery.RecoverBeforeShellStart();
            _shellIntegration.CaptureStartupArguments(_startupArguments);
            try
            {
                _shellIntegration.RegisterCurrentUserFileHandlers();
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or System.Security.SecurityException or IOException or InvalidOperationException)
            {
                _shellAssociationWarning = ex.Message;
            }

            var env = await CoreWebView2Environment.CreateAsync(userDataFolder: Path.Combine(_dataRoot, "WebView2"));
            await _web.EnsureCoreWebView2Async(env);
            var core = _web.CoreWebView2;
            _core = core;
            core.Settings.AreDevToolsEnabled = true;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = true;
            core.SetVirtualHostNameToFolderMapping("swir.local", _repoRoot, CoreWebView2HostResourceAccessKind.DenyCors);
            _isolation.Configure(core, _repoRoot);
            AttachBridge();
            var bootstrap = NativeBridgeScript
                .Replace("__SESSION_ID__", _capabilities.SessionId)
                .Replace("__EXECUTION_TOKEN__", _permissions.ShellExecutionToken);
            await core.AddScriptToExecuteOnDocumentCreatedAsync(bootstrap);

            var shellReady = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            void OnNavigationCompleted(object? _, CoreWebView2NavigationCompletedEventArgs args)
            {
                if (!args.IsSuccess)
                {
                    shellReady.TrySetException(new InvalidOperationException($"SWIR shell navigation failed: {args.WebErrorStatus}."));
                    return;
                }
                if (!IsTrustedShellSource(core.Source))
                {
                    shellReady.TrySetException(new InvalidOperationException("SWIR shell navigation completed on an unexpected origin."));
                    return;
                }
                shellReady.TrySetResult(true);
            }

            core.NavigationCompleted += OnNavigationCompleted;
            try
            {
                core.Navigate("https://swir.local/index.html");
                await shellReady.Task.WaitAsync(TimeSpan.FromSeconds(20));
            }
            finally
            {
                core.NavigationCompleted -= OnNavigationCompleted;
            }

            _shellIntegration.InitializeWindow(Handle);
            _startupHealth?.ConfirmShellReady();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.ToString(), "SWIR Desktop Host failed to start", MessageBoxButtons.OK, MessageBoxIcon.Error);
            RequestHostExit();
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (!IsDisposed && !Disposing && _shellIntegration.TryResolveWindowMessage(m.Msg, m.WParam, out var action))
        {
            HandleShellShortcut(action);
            return;
        }
        base.WndProc(ref m);
    }

    private void HandleShellShortcut(string? action)
    {
        switch (action)
        {
            case "shell.toggle-visibility":
                if (Visible && WindowState != FormWindowState.Minimized)
                    _tray.Hide();
                else
                    _tray.Restore();
                break;
            case "shell.open-matrix":
                _tray.Restore();
                PostNativeHostEvent(new NativeHostEvent("swir-native-event", "shell.action", new { action = "shell.open-matrix", source = "global-shortcut" }));
                break;
        }
    }

    private void OnHostResize(object? sender, EventArgs e)
    {
        if (WindowState != FormWindowState.Minimized || IsDisposed || Disposing)
            return;

        BeginInvoke(new Action(() =>
        {
            if (!IsDisposed && !Disposing && WindowState == FormWindowState.Minimized)
                _tray.Hide();
        }));
    }

    private void OnHostFormClosing(object? sender, FormClosingEventArgs e)
    {
        var trayState = _trayLifecycle.Describe().WindowState;
        if (e.CloseReason == CloseReason.UserClosing && trayState is not "exiting" and not "disposed")
        {
            e.Cancel = true;
            _tray.Hide();
            return;
        }

        _trayLifecycle.RequestExit();
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        BridgeRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<BridgeRequest>(e.WebMessageAsJson, JsonOptions);
            if (request is null || request.Type != "swir-native-call" || string.IsNullOrWhiteSpace(request.Id)) return;
        }
        catch { return; }

        if (!_restartSession.TryEnterBridgeRequest(out var bridgeLease) || bridgeLease is null)
        {
            PostBridgeResponse(new BridgeResponse(
                "swir-native-result",
                request.Id,
                false,
                null,
                new BridgeError("UPDATE_RESTART_IN_PROGRESS", "Desktop host is draining native requests for update restart.")));
            return;
        }

        var executeQueuedUpdateRestart = false;
        var executeQueuedUpdatePreparation = false;
        using (bridgeLease)
        {
            BridgeResponse response;
            try
            {
                var trustedShell = IsTrustedShellSource(e.Source);
                string? effectiveToken;
                if (trustedShell)
                    effectiveToken = request.ContextToken;
                else if (_isolation.TryResolveEntrySource(e.Source, out var packageId) && packageId is not null)
                    effectiveToken = _permissions.RequirePackageExecutionToken(packageId);
                else
                    return;

                var result = await DispatchAsync(request, effectiveToken, trustedShell);
                response = new BridgeResponse("swir-native-result", request.Id, true, result, null);
            }
            catch (Exception ex)
            {
                response = new BridgeResponse("swir-native-result", request.Id, false, null, new BridgeError(MapErrorCode(ex), ex.Message));
            }

            var responsePosted = PostBridgeResponse(response);
            if (response.Ok && string.Equals(request.Surface, "updates", StringComparison.Ordinal))
            {
                if (string.Equals(request.Method, "applyAndRestart", StringComparison.Ordinal))
                {
                    if (responsePosted)
                        executeQueuedUpdateRestart = true;
                    else
                        _updateBridgeCoordinator.CancelQueuedAfterResponseFailure();
                }
                else if (string.Equals(request.Method, "prepare", StringComparison.Ordinal))
                {
                    if (responsePosted)
                        executeQueuedUpdatePreparation = true;
                    else
                        _updatePreparationHost.CancelQueuedAfterResponseFailure();
                }
            }
        }

        if (executeQueuedUpdatePreparation)
        {
            try
            {
                var result = await _updatePreparationHost.ExecuteQueuedAsync();
                PostNativeHostEvent(new NativeHostEvent("swir-native-event", "updates.preparationCompleted", result));
            }
            catch (Exception ex)
            {
                PostNativeHostEvent(new NativeHostEvent(
                    "swir-native-event",
                    "updates.preparationFailed",
                    new { code = MapErrorCode(ex), message = ex.Message }));
            }
        }

        if (!executeQueuedUpdateRestart) return;
        try
        {
            await _updateBridgeCoordinator.ExecuteQueuedAsync();
        }
        catch (Exception ex)
        {
            PostNativeHostEvent(new NativeHostEvent(
                "swir-native-event",
                "updates.restartFailed",
                new { code = MapErrorCode(ex), message = ex.Message }));
        }
    }

    internal object DescribeUpdateRestartReadiness() => _updateRestartController.Describe();

    internal Task<DesktopUpdateRestartLifecycle.RestartLifecycleResult> ApplyPreparedUpdateAndRestartAsync(
        CancellationToken cancellationToken = default)
        => _updateRestartController.RestartReadyAsync(
            _restartHooks.PrepareAsync,
            RequestHostExit,
            _restartHooks.ResumeAsync,
            cancellationToken);

    private Task SuspendHostForUpdateRestartAsync(CancellationToken cancellationToken)
        => InvokeOnUiThreadAsync(() =>
        {
            DetachBridge();
            _core?.Stop();
        }, cancellationToken);

    private Task ResumeHostAfterUpdateRestartFailureAsync(CancellationToken cancellationToken)
        => InvokeOnUiThreadAsync(AttachBridge, cancellationToken);

    private void RequestHostExit()
    {
        if (IsDisposed || Disposing) return;
        if (InvokeRequired)
        {
            BeginInvoke(new Action(RequestHostExit));
            return;
        }
        _trayLifecycle.RequestExit();
        Close();
    }

    private void AttachBridge()
    {
        if (_core is null || _bridgeAttached || IsDisposed || Disposing) return;
        _core.WebMessageReceived += OnWebMessageReceived;
        _bridgeAttached = true;
    }

    private void DetachBridge()
    {
        if (_core is null || !_bridgeAttached) return;
        _core.WebMessageReceived -= OnWebMessageReceived;
        _bridgeAttached = false;
    }

    private Task InvokeOnUiThreadAsync(Action action, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(action);
        cancellationToken.ThrowIfCancellationRequested();
        if (IsDisposed || Disposing)
            throw new ObjectDisposedException(nameof(MainWindow));

        if (!InvokeRequired)
        {
            action();
            return Task.CompletedTask;
        }

        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        BeginInvoke(new Action(() =>
        {
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (IsDisposed || Disposing) throw new ObjectDisposedException(nameof(MainWindow));
                action();
                completion.TrySetResult(true);
            }
            catch (OperationCanceledException ex) { completion.TrySetCanceled(ex.CancellationToken); }
            catch (Exception ex) { completion.TrySetException(ex); }
        }));
        return completion.Task;
    }

    private bool PostBridgeResponse(BridgeResponse response)
    {
        var core = _core;
        if (core is null || IsDisposed || Disposing) return false;
        try
        {
            core.PostWebMessageAsJson(JsonSerializer.Serialize(response, JsonOptions));
            return true;
        }
        catch (InvalidOperationException) when (!_bridgeAttached || IsDisposed || Disposing) { return false; }
    }

    private bool PostNativeHostEvent(NativeHostEvent hostEvent)
    {
        var core = _core;
        if (core is null || IsDisposed || Disposing || !_bridgeAttached) return false;
        try
        {
            core.PostWebMessageAsJson(JsonSerializer.Serialize(hostEvent, JsonOptions));
            return true;
        }
        catch (InvalidOperationException) when (!_bridgeAttached || IsDisposed || Disposing) { return false; }
    }

    private Task<object?> DispatchAsync(BridgeRequest request, string? effectiveToken, bool trustedShell)
    {
        if (string.Equals(request.Surface, "appdata", StringComparison.Ordinal))
            return DispatchAppDataAsync(request.Method, request.Args, effectiveToken);

        if (string.Equals(request.Surface, "shellIntegration", StringComparison.Ordinal))
        {
            if (!trustedShell)
                throw new BridgeException("SHELL_INTEGRATION_FORBIDDEN", "Native shell integration is restricted to the trusted SWIR system shell.");
            return DispatchShellIntegrationAsync(request.Method, request.Args);
        }

        if (string.Equals(request.Surface, "notifications", StringComparison.Ordinal))
            return Task.FromResult<object?>(DesktopNotificationHostBinding.Dispatch(_notifications, request.Method, request.Args, effectiveToken));

        _permissions.Authorize(effectiveToken, request.Surface, request.Method, RequestedOwner(request));
        return request.Surface switch
        {
            "filesystem" => DispatchFilesystemAsync(request.Method, request.Args),
            "clipboard" => DispatchClipboardAsync(request.Method, request.Args),
            "processes" => DispatchProcessesAsync(request.Method),
            "services" => DispatchServicesAsync(request.Method),
            "network" => DispatchNetworkAsync(request.Method),
            "devices" => DispatchDevicesAsync(request.Method),
            "identity" => DispatchIdentityAsync(request.Method),
            "security" => DispatchSecurityAsync(request.Method, request.Args, effectiveToken),
            "packages" => DispatchPackagesAsync(request.Method, request.Args),
            "updates" => DispatchUpdatesAsync(request.Method, trustedShell),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported native surface: {request.Surface}")
        };
    }

    private Task<object?> DispatchShellIntegrationAsync(string method, JsonElement args)
    {
        object? result = method switch
        {
            "info" => new { host = _shellIntegration.Describe(), associationRegistrationWarning = _shellAssociationWarning },
            "pendingOpenFiles" => _shellIntegration.PendingOpenFiles(),
            "claimOpenFile" => _shellIntegration.ClaimOpenFile(ArgString(args, 0), Owner(args, 1)),
            "cancelOpenFile" => _shellIntegration.CancelOpenFile(ArgString(args, 0)),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported shell integration method: {method}")
        };
        return Task.FromResult(result);
    }

    private Task<object?> DispatchNetworkAsync(string method)
    {
        object? result = method switch
        {
            "status" => _deviceNetwork.NetworkStatus(),
            "adapters" => _deviceNetwork.NetworkAdapters(),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported network method: {method}")
        };
        return Task.FromResult(result);
    }

    private Task<object?> DispatchDevicesAsync(string method)
    {
        object? result = method switch
        {
            "info" => _deviceNetwork.Describe(),
            "list" => _deviceNetwork.Devices(),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported devices method: {method}")
        };
        return Task.FromResult(result);
    }

    private Task<object?> DispatchIdentityAsync(string method)
    {
        object? result = method switch
        {
            "info" => _identity.Describe(),
            "account" => _identity.Account(),
            "session" => _identity.Session(),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported identity method: {method}")
        };
        return Task.FromResult(result);
    }

    private Task<object?> DispatchProcessesAsync(string method)
    {
        object? result = method switch
        {
            "info" => _processServices.Describe(),
            "list" => _processServices.GetProcesses(),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported processes method: {method}")
        };
        return Task.FromResult(result);
    }

    private Task<object?> DispatchServicesAsync(string method)
    {
        object? result = method switch
        {
            "info" => _processServices.Describe(),
            "list" => _processServices.GetServices(),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported services method: {method}")
        };
        return Task.FromResult(result);
    }

    private async Task<object?> DispatchUpdatesAsync(string method, bool trustedShell)
    {
        return method switch
        {
            "readiness" => _updateBridgeCoordinator.Describe(),
            "check" => await _updatePreparationHost.CheckAsync(trustedShell).ConfigureAwait(false),
            "preparationStatus" => _updatePreparationHost.Describe(),
            "prepare" => _updatePreparationHost.QueuePrepare(trustedShell),
            "cancelPrepare" => _updatePreparationHost.Cancel(trustedShell),
            "resetPreparation" => _updatePreparationHost.ResetTerminalState(trustedShell),
            "applyAndRestart" => _updateBridgeCoordinator.PrepareApply(trustedShell),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported updates method: {method}")
        };
    }

    private Task<object?> DispatchAppDataAsync(string method, JsonElement args, string? callerToken)
    {
        var packageId = Owner(args, 0);
        _permissions.AuthorizePackageTarget(callerToken, packageId, "appdata", method);
        object? result = method switch
        {
            "info" => _appData.Info(packageId),
            "list" => _appData.List(packageId),
            "get" => _appData.Get(packageId, ArgString(args, 1), ArgElement(args, 2)),
            "set" => _appData.Set(packageId, ArgString(args, 1), ArgElement(args, 2)),
            "remove" => _appData.Remove(packageId, ArgString(args, 1)),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported App Data method: {method}")
        };
        return Task.FromResult(result);
    }

    private Task<object?> DispatchFilesystemAsync(string method, JsonElement args)
    {
        object? result = method switch
        {
            "info" => _nativeFileSystem.Describe(),
            "list" => _nativeFileSystem.List(),
            "get" => _nativeFileSystem.Get(ArgString(args, 0)),
            "save" => SaveNativeFile(ArgObject(args, 0)),
            "remove" => _nativeFileSystem.Remove(ArgString(args, 0)),
            "pickFile" => PickFile(Owner(args, 0)),
            "pickDirectory" => PickDirectory(Owner(args, 0)),
            "capabilityInfo" => _capabilities.Describe(ArgString(args, 0), Owner(args, 1)),
            "readCapabilityText" => _capabilities.ReadText(ArgString(args, 0), Owner(args, 1)),
            "revokeCapability" => _capabilities.Revoke(ArgString(args, 0), Owner(args, 1)),
            "revokeOwnerCapabilities" => _capabilities.RevokeOwner(Owner(args, 0)),
            "pruneCapabilities" => _capabilities.PruneExpired(),
            "capabilityStatus" => _capabilities.Status(),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported filesystem method: {method}")
        };
        return Task.FromResult(result);
    }

    private Task<object?> DispatchPackagesAsync(string method, JsonElement args)
    {
        object? result = method switch
        {
            "info" => _packages.Describe(),
            "installFromCapability" => _packages.InstallFromCapability(ArgString(args, 0), ArgString(args, 1), Owner(args, 2)),
            "status" => _packages.Status(ArgString(args, 0), Owner(args, 1)),
            "rollback" => _packages.Rollback(ArgString(args, 0), Owner(args, 1)),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported packages method: {method}")
        };
        return Task.FromResult(result);
    }

    private Task<object?> DispatchClipboardAsync(string method, JsonElement args)
    {
        object? result = method switch
        {
            "readText" => Clipboard.ContainsText() ? Clipboard.GetText() : string.Empty,
            "writeText" => WriteClipboard(ArgString(args, 0)),
            "clear" => ClearClipboard(),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported clipboard method: {method}")
        };
        return Task.FromResult(result);
    }

    private Task<object?> DispatchSecurityAsync(string method, JsonElement args, string? contextToken)
    {
        object? result = method switch
        {
            "contextInfo" => _permissions.Describe(contextToken),
            "can" => _permissions.Can(contextToken, ArgString(args, 0)),
            "policyCatalog" => _policyCatalog.Describe(),
            "appUrl" => _isolation.AppUrl(ArgString(args, 0), ArgString(args, 1)),
            "isolationInfo" => _isolation.Describe(),
            "syncPackageContexts" => _permissions.SynchronizeApplicationContexts(ParsePackageContexts(args)),
            "packageContexts" => _permissions.DescribePackageContexts(),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported security method: {method}")
        };
        return Task.FromResult(result);
    }

    private object SaveNativeFile(JsonElement file)
    {
        var name = file.TryGetProperty("id", out var idProp) ? idProp.GetString() : null;
        name ??= file.TryGetProperty("name", out var nameProp) ? nameProp.GetString() : null;
        if (string.IsNullOrWhiteSpace(name)) throw new BridgeException("INVALID_ARGUMENT", "File id/name is required.");
        var content = file.TryGetProperty("content", out var contentProp) ? contentProp.GetString() ?? string.Empty : string.Empty;
        return _nativeFileSystem.Save(name, content);
    }

    private object? PickFile(string ownerAppId)
    {
        using var dialog = new OpenFileDialog { CheckFileExists = true, Multiselect = false, Title = "Open file in SWIR OS" };
        return dialog.ShowDialog(this) == DialogResult.OK ? _capabilities.RegisterFile(dialog.FileName, ownerAppId) : null;
    }

    private object? PickDirectory(string ownerAppId)
    {
        using var dialog = new FolderBrowserDialog { Description = "Choose a folder for SWIR OS" };
        return dialog.ShowDialog(this) == DialogResult.OK ? _capabilities.RegisterDirectory(dialog.SelectedPath, ownerAppId) : null;
    }

    private static bool WriteClipboard(string text) { Clipboard.SetText(text ?? string.Empty); return true; }
    private static bool ClearClipboard() { Clipboard.Clear(); return true; }

    private static PermissionBroker.PackageContextRequest[] ParsePackageContexts(JsonElement args)
    {
        if (args.ValueKind != JsonValueKind.Array || args.GetArrayLength() < 1 || args[0].ValueKind != JsonValueKind.Array)
            throw new BridgeException("INVALID_ARGUMENT", "Package context synchronization requires an array.");

        var result = new List<PermissionBroker.PackageContextRequest>();
        foreach (var item in args[0].EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("packageId", out var packageIdProp) || packageIdProp.ValueKind != JsonValueKind.String)
                throw new BridgeException("INVALID_ARGUMENT", "Each package context requires packageId.");
            var packageId = packageIdProp.GetString()?.Trim() ?? string.Empty;
            if (string.IsNullOrWhiteSpace(packageId)) throw new BridgeException("INVALID_APP_ID", "Package context packageId is required.");

            var permissions = Array.Empty<string>();
            if (item.TryGetProperty("permissions", out var permissionsProp))
            {
                if (permissionsProp.ValueKind != JsonValueKind.Array)
                    throw new BridgeException("INVALID_ARGUMENT", "Package context permissions must be an array.");
                permissions = permissionsProp.EnumerateArray().Select(permission =>
                {
                    if (permission.ValueKind != JsonValueKind.String)
                        throw new BridgeException("INVALID_ARGUMENT", "Package context permissions must be strings.");
                    return permission.GetString() ?? string.Empty;
                }).Where(permission => !string.IsNullOrWhiteSpace(permission)).ToArray();
            }
            result.Add(new PermissionBroker.PackageContextRequest(packageId, permissions));
        }
        return result.ToArray();
    }

    private static string? RequestedOwner(BridgeRequest request)
    {
        if (string.Equals(request.Surface, "filesystem", StringComparison.Ordinal))
        {
            return request.Method switch
            {
                "pickFile" or "pickDirectory" => Owner(request.Args, 0),
                "capabilityInfo" or "readCapabilityText" or "revokeCapability" => Owner(request.Args, 1),
                "revokeOwnerCapabilities" => Owner(request.Args, 0),
                _ => null
            };
        }

        if (string.Equals(request.Surface, "packages", StringComparison.Ordinal))
        {
            return request.Method switch
            {
                "installFromCapability" => Owner(request.Args, 2),
                "status" or "rollback" => Owner(request.Args, 1),
                _ => null
            };
        }
        return null;
    }

    private static string Owner(JsonElement args, int index)
    {
        var owner = ArgString(args, index).Trim();
        if (string.IsNullOrWhiteSpace(owner))
            throw new BridgeException("INVALID_APP_ID", "Application identity is required for capability operations.");
        if (owner.Length > 128 || owner.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '.' or '-' or '_')))
            throw new BridgeException("INVALID_APP_ID", "Application identity contains unsupported characters.");
        return owner;
    }

    private static string ArgString(JsonElement args, int index)
    {
        if (args.ValueKind != JsonValueKind.Array || args.GetArrayLength() <= index) return string.Empty;
        return args[index].ValueKind == JsonValueKind.String ? args[index].GetString() ?? string.Empty : args[index].ToString();
    }

    private static JsonElement ArgElement(JsonElement args, int index)
    {
        if (args.ValueKind != JsonValueKind.Array || args.GetArrayLength() <= index)
            return JsonDocument.Parse("null").RootElement.Clone();
        return args[index].Clone();
    }

    private static JsonElement ArgObject(JsonElement args, int index)
    {
        if (args.ValueKind != JsonValueKind.Array || args.GetArrayLength() <= index || args[index].ValueKind != JsonValueKind.Object)
            throw new BridgeException("INVALID_ARGUMENT", "Object argument required.");
        return args[index];
    }

    private static bool IsTrustedShellSource(string source)
    {
        return Uri.TryCreate(source, UriKind.Absolute, out var uri)
            && string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            && string.Equals(uri.Host, "swir.local", StringComparison.OrdinalIgnoreCase)
            && uri.IsDefaultPort
            && string.IsNullOrEmpty(uri.UserInfo)
            && string.Equals(uri.AbsolutePath, "/index.html", StringComparison.OrdinalIgnoreCase);
    }

    private static string ResolveRepoRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && current is not null; i++, current = current.Parent)
            if (File.Exists(Path.Combine(current.FullName, "index.html"))) return current.FullName;
        throw new DirectoryNotFoundException("Could not find SWIR OS repository root containing index.html.");
    }

    private static string MapErrorCode(Exception ex) => ex switch
    {
        BridgeException bridge => bridge.Code,
        NativeFileSystemException nativeFileSystem => nativeFileSystem.Code,
        DesktopPackageException package => package.Code,
        DeviceNetworkBrokerException deviceNetwork => deviceNetwork.Code,
        DesktopUpdateBridgeCommandException updateBridge => updateBridge.Code,
        UpdateSecurityException updateSecurity => updateSecurity.Code,
        _ => "NATIVE_HOST_ERROR"
    };

    private const string NativeBridgeScript = """
(() => {
  if (window.top !== window || location.hostname !== 'swir.local' || location.pathname !== '/index.html') return;
  if (window.SWIR_NATIVE_HOST) return;
  const pending = new Map(); let seq = 0;
  const executionToken = '__EXECUTION_TOKEN__';
  const postMessage = chrome.webview.postMessage.bind(chrome.webview);
  const call = (surface, method, ...args) => new Promise((resolve, reject) => {
    const id = `swir-${Date.now()}-${++seq}`; pending.set(id, { resolve, reject });
    postMessage({ type: 'swir-native-call', id, surface, method, args, contextToken: executionToken });
  });
  const updateFrame = () => {
    const frame = document.querySelector('.os-window[data-window="updates"] iframe');
    if (!(frame instanceof HTMLIFrameElement)) return null;
    try {
      const url = new URL(frame.src, location.href);
      if (url.origin !== location.origin || url.pathname !== '/swir-updates.html') return null;
    } catch { return null; }
    return frame;
  };
  const forwardUpdateEvent = (name, detail) => {
    const frame = updateFrame();
    frame?.contentWindow?.postMessage({ type: 'swir-update-host-event', name, detail: detail || {} }, location.origin);
  };
  chrome.webview.addEventListener('message', event => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'swir-native-result' && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result); else { const error = new Error(msg.error?.message || 'Native host error'); error.code = msg.error?.code || 'NATIVE_HOST_ERROR'; p.reject(error); }
      return;
    }
    if (msg.type === 'swir-native-event' && msg.name === 'shell.action') {
      const detail = msg.detail || {};
      window.dispatchEvent(new CustomEvent('swir:native-shell-action', { detail }));
      if (detail.action === 'shell.open-matrix') window.postMessage({ type: 'SWIR_NATIVE_OPEN', id: 'matrix' }, location.origin);
      return;
    }
    if (msg.type === 'swir-native-event' && msg.name === 'updates.restartFailed') {
      window.dispatchEvent(new CustomEvent('swir:native-update-restart-failed', { detail: msg.detail || {} }));
      forwardUpdateEvent(msg.name, msg.detail);
      return;
    }
    if (msg.type === 'swir-native-event' && (msg.name === 'updates.preparationCompleted' || msg.name === 'updates.preparationFailed')) {
      window.dispatchEvent(new CustomEvent(`swir:native-${msg.name.replaceAll('.', '-')}`, { detail: msg.detail || {} }));
      forwardUpdateEvent(msg.name, msg.detail);
    }
  });
  window.addEventListener('message', async event => {
    const msg = event.data;
    if (!msg || msg.type !== 'swir-system-update-command' || typeof msg.id !== 'string') return;
    const frame = updateFrame();
    if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin) return;
    const allowed = new Set(['check','preparationStatus','prepare','cancelPrepare','resetPreparation','applyAndRestart']);
    if (!allowed.has(msg.method)) return;
    try {
      const result = await call('updates', msg.method);
      frame.contentWindow?.postMessage({ type: 'swir-system-update-result', id: msg.id, ok: true, result }, location.origin);
    } catch (error) {
      frame.contentWindow?.postMessage({ type: 'swir-system-update-result', id: msg.id, ok: false, error: { code: error?.code || 'NATIVE_HOST_ERROR', message: error?.message || 'Native host error' } }, location.origin);
    }
  });
  const surface = (name, methods) => Object.freeze(Object.fromEntries(methods.map(method => [method, (...args) => call(name, method, ...args)])));
  window.SWIR_NATIVE_HOST = Object.freeze({
    edition: 'DESKTOP', version: '0.5.7-preview', contract: 'swir.runtime/1.0', sessionId: '__SESSION_ID__',
    features: Object.freeze({ packageContextBroker: true, nativePackageBridge: true, appIsolationRouting: true, appIsolationState: 'APP_BRIDGE_VERIFIED', nativeAppData: true, nativeFilesystem: true, nativeDeviceNetwork: true, nativeAccountSession: true, nativeProcessService: true, nativeClipboardTray: true, nativeNotifications: true, nativeShellIntegration: true, guardedUpdateRestartLifecycle: true, nativeUpdateBridge: true, nativeUpdatePreparation: true }),
    filesystem: surface('filesystem', ['info','list','get','save','remove','pickFile','pickDirectory','capabilityInfo','readCapabilityText','revokeCapability','revokeOwnerCapabilities','pruneCapabilities','capabilityStatus']),
    appData: surface('appdata', ['info','list','get','set','remove']),
    packages: surface('packages', ['info','installFromCapability','status','rollback']),
    clipboard: surface('clipboard', ['readText','writeText','clear']),
    notifications: surface('notifications', ['show']),
    processes: surface('processes', ['info','list']),
    services: surface('services', ['info','list']),
    network: surface('network', ['status','adapters']),
    devices: surface('devices', ['info','list']),
    identity: surface('identity', ['info','account','session']),
    security: surface('security', ['contextInfo','can','policyCatalog','appUrl','isolationInfo','syncPackageContexts','packageContexts']),
    shellIntegration: surface('shellIntegration', ['info','pendingOpenFiles','claimOpenFile','cancelOpenFile']),
    updates: surface('updates', ['readiness'])
  });
  window.dispatchEvent(new CustomEvent('swir:native-host-ready', { detail: { edition: 'DESKTOP', version: '0.5.7-preview', sessionId: '__SESSION_ID__' } }));
})();
""";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = true };
}

internal sealed record BridgeRequest(string Type, string Id, string Surface, string Method, JsonElement Args, string? ContextToken);
internal sealed record BridgeResponse(string Type, string Id, bool Ok, object? Result, BridgeError? Error);
internal sealed record BridgeError(string Code, string Message);
internal sealed record NativeHostEvent(string Type, string Name, object? Detail);
internal sealed class BridgeException(string code, string message) : Exception(message) { public string Code { get; } = code; }
