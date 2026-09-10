using System.Diagnostics;
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
    private readonly string _repoRoot;
    private readonly string _dataRoot;

    public MainWindow()
    {
        Text = "SWIR OS Desktop Edition Preview";
        Width = 1440;
        Height = 900;
        MinimumSize = new Size(1024, 700);
        StartPosition = FormStartPosition.CenterScreen;

        _repoRoot = ResolveRepoRoot();
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

            core.SetVirtualHostNameToFolderMapping(
                "swir.local",
                _repoRoot,
                CoreWebView2HostResourceAccessKind.DenyCors);

            core.WebMessageReceived += OnWebMessageReceived;
            await core.AddScriptToExecuteOnDocumentCreatedAsync(NativeBridgeScript);
            core.Navigate("https://swir.local/index.html");
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
        catch
        {
            return;
        }

        BridgeResponse response;
        try
        {
            var result = await DispatchAsync(request);
            response = new BridgeResponse("swir-native-result", request.Id, true, result, null);
        }
        catch (Exception ex)
        {
            response = new BridgeResponse("swir-native-result", request.Id, false, null, new BridgeError(MapErrorCode(ex), ex.Message));
        }

        var json = JsonSerializer.Serialize(response, JsonOptions);
        _web.CoreWebView2.PostWebMessageAsJson(json);
    }

    private Task<object?> DispatchAsync(BridgeRequest request)
    {
        return request.Surface switch
        {
            "filesystem" => DispatchFilesystemAsync(request.Method, request.Args),
            "clipboard" => DispatchClipboardAsync(request.Method, request.Args),
            "processes" => DispatchProcessesAsync(request.Method, request.Args),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported native surface: {request.Surface}")
        };
    }

    private Task<object?> DispatchFilesystemAsync(string method, JsonElement args)
    {
        object? result = method switch
        {
            "list" => ListFiles(),
            "get" => GetFile(ArgString(args, 0)),
            "save" => SaveFile(ArgObject(args, 0)),
            "remove" => RemoveFile(ArgString(args, 0)),
            "pickFile" => PickFile(),
            "pickDirectory" => PickDirectory(),
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
            "kill" => throw new BridgeException("PERMISSION_DENIED", "Desktop host does not allow process termination yet."),
            "spawn" => throw new BridgeException("PERMISSION_DENIED", "Process spawning is disabled until a permission broker is implemented."),
            _ => throw new BridgeException("RUNTIME_UNSUPPORTED", $"Unsupported processes method: {method}")
        };
        return Task.FromResult(result);
    }

    private object[] ListFiles()
    {
        return Directory.EnumerateFiles(_dataRoot, "*", SearchOption.TopDirectoryOnly)
            .Where(path => !path.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase))
            .Select(path => new FileInfo(path))
            .Select(info => new object[] { info.Name, info.Length, info.LastWriteTimeUtc })
            .ToArray();
    }

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

    private object? PickFile()
    {
        using var dialog = new OpenFileDialog { CheckFileExists = true, Multiselect = false, Title = "Open file in SWIR OS" };
        if (dialog.ShowDialog(this) != DialogResult.OK) return null;
        var info = new FileInfo(dialog.FileName);
        return new { name = info.Name, nativePath = info.FullName, size = info.Length, content = File.ReadAllText(info.FullName) };
    }

    private object? PickDirectory()
    {
        using var dialog = new FolderBrowserDialog { Description = "Choose a folder for SWIR OS" };
        return dialog.ShowDialog(this) == DialogResult.OK ? new { nativePath = dialog.SelectedPath, name = new DirectoryInfo(dialog.SelectedPath).Name } : null;
    }

    private static bool WriteClipboard(string text)
    {
        Clipboard.SetText(text ?? string.Empty);
        return true;
    }

    private static bool ClearClipboard()
    {
        Clipboard.Clear();
        return true;
    }

    private string SafeDataPath(string id)
    {
        var safeName = Path.GetFileName(id);
        if (string.IsNullOrWhiteSpace(safeName) || !string.Equals(safeName, id, StringComparison.Ordinal))
            throw new BridgeException("INVALID_PATH", "Only sandboxed file names are accepted by the preview host.");
        return Path.Combine(_dataRoot, safeName);
    }

    private static string ArgString(JsonElement args, int index)
    {
        if (args.ValueKind != JsonValueKind.Array || args.GetArrayLength() <= index) return string.Empty;
        return args[index].ValueKind == JsonValueKind.String ? args[index].GetString() ?? string.Empty : args[index].ToString();
    }

    private static JsonElement ArgObject(JsonElement args, int index)
    {
        if (args.ValueKind != JsonValueKind.Array || args.GetArrayLength() <= index || args[index].ValueKind != JsonValueKind.Object)
            throw new BridgeException("INVALID_ARGUMENT", "Object argument required.");
        return args[index];
    }

    private static string ResolveRepoRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && current is not null; i++, current = current.Parent)
        {
            if (File.Exists(Path.Combine(current.FullName, "index.html"))) return current.FullName;
        }
        throw new DirectoryNotFoundException("Could not find SWIR OS repository root containing index.html.");
    }

    private static string MapErrorCode(Exception ex) => ex is BridgeException bridge ? bridge.Code : "NATIVE_HOST_ERROR";

    private const string NativeBridgeScript = """
(() => {
  if (window.SWIR_NATIVE_HOST) return;
  const pending = new Map();
  let seq = 0;
  const call = (surface, method, ...args) => new Promise((resolve, reject) => {
    const id = `swir-${Date.now()}-${++seq}`;
    pending.set(id, { resolve, reject });
    chrome.webview.postMessage({ type: 'swir-native-call', id, surface, method, args });
  });
  chrome.webview.addEventListener('message', event => {
    const msg = event.data;
    if (!msg || msg.type !== 'swir-native-result' || !pending.has(msg.id)) return;
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else { const error = new Error(msg.error?.message || 'Native host error'); error.code = msg.error?.code || 'NATIVE_HOST_ERROR'; p.reject(error); }
  });
  const surface = name => new Proxy({}, { get: (_, method) => (...args) => call(name, String(method), ...args) });
  window.SWIR_NATIVE_HOST = Object.freeze({
    edition: 'DESKTOP',
    version: '0.1.0-preview',
    contract: 'swir.runtime/1.0',
    filesystem: surface('filesystem'),
    clipboard: surface('clipboard'),
    processes: surface('processes')
  });
  window.dispatchEvent(new CustomEvent('swir:native-host-ready', { detail: { edition: 'DESKTOP', version: '0.1.0-preview' } }));
})();
""";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = true };
}

internal sealed record BridgeRequest(string Type, string Id, string Surface, string Method, JsonElement Args);
internal sealed record BridgeResponse(string Type, string Id, bool Ok, object? Result, BridgeError? Error);
internal sealed record BridgeError(string Code, string Message);

internal sealed class BridgeException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
