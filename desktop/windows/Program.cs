using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Swir.Desktop.Host;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainWindow());
    }
}

internal sealed class MainWindow : Form
{
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly CapabilityBroker _capabilities = new();
    private readonly AppDataBroker _appData = new();
    private readonly PermissionBroker _permissions;
    private readonly ExecutionPolicyCatalog _policyCatalog;
    private readonly AppIsolationRegistry _isolation;
    private readonly StartupHealthHandshake? _startupHealth;
    private readonly string _repoRoot;
    private readonly string _dataRoot;

    public MainWindow()
    {
        Text = "SWIR OS Desktop Edition Preview";
        Width = 1440;
        Height = 900;
        MinimumSize = new Size(1024, 700);
        StartPosition = FormStartPosition.CenterScreen;
        _startupHealth = StartupHealthHandshake.CaptureFromEnvironment();
        _repoRoot = ResolveRepoRoot();
        _policyCatalog = new ExecutionPolicyCatalog(Path.Combine(_repoRoot, "desktop", "windows", "app-policy.json"));
        _isolation = new AppIsolationRegistry(_policyCatalog);
        _permissions = new PermissionBroker(_capabilities, _policyCatalog);
        _dataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SWIR", "DesktopHost", "Data");
        Directory.CreateDirectory(_dataRoot);
        Controls.Add(_web);
        Shown += async (_, _) => await StartAsync();
    }

    private async Task StartAsync()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(userDataFolder: Path.Combine(_dataRoot, "WebView2"));
            await _web.EnsureCoreWebView2Async(env);
            var core = _web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = true;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = true;
            core.SetVirtualHostNameToFolderMapping("swir.local", _repoRoot, CoreWebView2HostResourceAccessKind.DenyCors);
            _isolation.Configure(core, _repoRoot);
            core.WebMessageReceived += OnWebMessageReceived;
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

            _startupHealth?.ConfirmShellReady();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.ToString(), "SWIR Desktop Host failed to start", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
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

        BridgeResponse response;
        try
        {
            string? effectiveToken;
            if (IsTrustedShellSource(e.Source))
                effectiveToken = request.ContextToken;
            else if (_isolation.TryResolveEntrySource(e.Source, out var packageId) && packageId is not null)
                effectiveToken = _permissions.RequirePackageExecutionToken(packageId);
            else
                return;

            var result = await DispatchAsync(request, effectiveToken);
            response = new BridgeResponse("swir-native-result", request.Id, true, result, null);
        }
        catch (Exception ex)
        {
            response = new BridgeResponse("swir-native-result", request.Id, false, null, new BridgeError(MapErrorCode(ex), ex.Message));
        }
        _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(response, JsonOptions));
    }

    private Task<object?> DispatchAsync(BridgeRequest request, string? effectiveToken)
    {
        if (string.Equals(request.Surface, "appdata", StringComparison.Ordinal))
            return DispatchAppDataAsync(request.Method, request.Args, effectiveToken);

        _permissions.Authorize(effectiveToken, request.Surface, request.Method, RequestedOwner(request));
        return request.Surface switch
        {
            "filesystem" => DispatchFilesystemAsync(request.Method, request.Args),
            "clipboard" => DispatchClipboardAsync(request.Method, request.Args),
            "processes" => DispatchProcessesAsync(request.Method, request.Args),
            "security" => DispatchSecurityAsync(request.Method, request.Args, effectiveToken),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported native surface: {request.Surface}")
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
            "list" => ListFiles(),
            "get" => GetFile(ArgString(args, 0)),
            "save" => SaveFile(ArgObject(args, 0)),
            "remove" => RemoveFile(ArgString(args, 0)),
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

    private Task<object?> DispatchProcessesAsync(string method, JsonElement args)
    {
        object? result = method switch
        {
            "list" => new[] { new { pid = Environment.ProcessId, name = "SWIR.Desktop.Host", kind = "desktop-host" } },
            "open" => new { ok = true, pid = Environment.ProcessId },
            "kill" => throw new BridgeException("PERMISSION_DENIED", "Process termination is not granted to the shell execution context."),
            "spawn" => throw new BridgeException("PERMISSION_DENIED", "Process spawning is not granted to the shell execution context."),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported processes method: {method}")
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

    private object[] ListFiles() => Directory.EnumerateFiles(_dataRoot, "*", SearchOption.TopDirectoryOnly)
        .Where(path => !path.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase))
        .Select(path => new FileInfo(path)).Select(info => new object[] { info.Name, info.Length, info.LastWriteTimeUtc }).ToArray();

    private object? GetFile(string id)
    {
        var path = SafeDataPath(id);
        if (!File.Exists(path)) return null;
        var info = new FileInfo(path);
        return new { id = info.Name, name = info.Name, content = File.ReadAllText(path), size = info.Length, modified = info.LastWriteTimeUtc };
    }

    private object SaveFile(JsonElement file)
    {
        var name = file.TryGetProperty("id", out var idProp) ? idProp.GetString() : null;
        name ??= file.TryGetProperty("name", out var nameProp) ? nameProp.GetString() : null;
        if (string.IsNullOrWhiteSpace(name)) throw new BridgeException("INVALID_ARGUMENT", "File id/name is required.");
        var content = file.TryGetProperty("content", out var contentProp) ? contentProp.GetString() ?? string.Empty : string.Empty;
        var path = SafeDataPath(name);
        File.WriteAllText(path, content);
        var info = new FileInfo(path);
        return new { id = info.Name, name = info.Name, size = info.Length, modified = info.LastWriteTimeUtc };
    }

    private bool RemoveFile(string id)
    {
        var path = SafeDataPath(id);
        if (!File.Exists(path)) return false;
        File.Delete(path);
        return true;
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

    private string SafeDataPath(string id)
    {
        var safeName = Path.GetFileName(id);
        if (string.IsNullOrWhiteSpace(safeName) || !string.Equals(safeName, id, StringComparison.Ordinal))
            throw new BridgeException("INVALID_PATH", "Only sandboxed file names are accepted by the preview host.");
        return Path.Combine(_dataRoot, safeName);
    }

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
        if (!string.Equals(request.Surface, "filesystem", StringComparison.Ordinal)) return null;
        return request.Method switch
        {
            "pickFile" or "pickDirectory" => Owner(request.Args, 0),
            "capabilityInfo" or "readCapabilityText" or "revokeCapability" => Owner(request.Args, 1),
            "revokeOwnerCapabilities" => Owner(request.Args, 0),
            _ => null
        };
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

    private static string MapErrorCode(Exception ex) => ex is BridgeException bridge ? bridge.Code : "NATIVE_HOST_ERROR";

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
  chrome.webview.addEventListener('message', event => {
    const msg = event.data;
    if (!msg || msg.type !== 'swir-native-result' || !pending.has(msg.id)) return;
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result); else { const error = new Error(msg.error?.message || 'Native host error'); error.code = msg.error?.code || 'NATIVE_HOST_ERROR'; p.reject(error); }
  });
  const surface = (name, methods) => Object.freeze(Object.fromEntries(methods.map(method => [method, (...args) => call(name, method, ...args)])));
  window.SWIR_NATIVE_HOST = Object.freeze({
    edition: 'DESKTOP', version: '0.5.1-preview', contract: 'swir.runtime/1.0', sessionId: '__SESSION_ID__',
    features: Object.freeze({ packageContextBroker: true, appIsolationRouting: true, appIsolationState: 'APP_BRIDGE_VERIFIED', nativeAppData: true }),
    filesystem: surface('filesystem', ['list','get','save','remove','pickFile','pickDirectory','capabilityInfo','readCapabilityText','revokeCapability','revokeOwnerCapabilities','pruneCapabilities','capabilityStatus']),
    appData: surface('appdata', ['info','list','get','set','remove']),
    clipboard: surface('clipboard', ['readText','writeText','clear']),
    processes: surface('processes', ['list','open','kill','spawn']),
    security: surface('security', ['contextInfo','can','policyCatalog','appUrl','isolationInfo','syncPackageContexts','packageContexts'])
  });
  window.dispatchEvent(new CustomEvent('swir:native-host-ready', { detail: { edition: 'DESKTOP', version: '0.5.1-preview', sessionId: '__SESSION_ID__' } }));
})();
""";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = true };
}

internal sealed record BridgeRequest(string Type, string Id, string Surface, string Method, JsonElement Args, string? ContextToken);
internal sealed record BridgeResponse(string Type, string Id, bool Ok, object? Result, BridgeError? Error);
internal sealed record BridgeError(string Code, string Message);
internal sealed class BridgeException(string code, string message) : Exception(message) { public string Code { get; } = code; }
