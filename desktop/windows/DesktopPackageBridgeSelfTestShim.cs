namespace Swir.Desktop.Host;

internal sealed class BridgeException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
