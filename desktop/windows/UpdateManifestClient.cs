using System.Net;
using System.Net.Http.Headers;
using System.Text;

namespace Swir.Desktop.Host;

internal sealed class UpdateManifestClient : IDisposable
{
    public const int MaxManifestBytes = 256 * 1024;
    private readonly UpdateBroker _broker;
    private readonly Uri _manifestUri;
    private readonly HashSet<string> _allowedHosts;
    private readonly HttpClient _http;
    private readonly TimeSpan _timeout;
    private readonly bool _ownsClient;

    public UpdateManifestClient(UpdateBroker broker, Uri manifestUri, IEnumerable<string> allowedHosts, TimeSpan? timeout = null)
        : this(broker, manifestUri, allowedHosts, CreateDefaultClient(), timeout, true) { }

    internal UpdateManifestClient(UpdateBroker broker, Uri manifestUri, IEnumerable<string> allowedHosts, HttpClient httpClient, TimeSpan? timeout = null, bool ownsClient = false)
    {
        _broker = broker ?? throw new ArgumentNullException(nameof(broker));
        _manifestUri = manifestUri ?? throw new ArgumentNullException(nameof(manifestUri));
        _allowedHosts = new HashSet<string>(allowedHosts ?? Array.Empty<string>(), StringComparer.OrdinalIgnoreCase);
        _http = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _timeout = timeout ?? TimeSpan.FromSeconds(30);
        _ownsClient = ownsClient;
        ValidateManifestUri(_manifestUri, _allowedHosts);
        if (_timeout <= TimeSpan.Zero || _timeout > TimeSpan.FromMinutes(5))
            throw new UpdateSecurityException("UPDATE_MANIFEST_TIMEOUT_INVALID", "Manifest timeout is outside the allowed range.");
    }

    public async Task<UpdateBroker.VerifiedUpdate> FetchAndVerifyAsync(Version currentVersion, string channel, CancellationToken cancellationToken = default)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(_timeout);
        using var request = new HttpRequestMessage(HttpMethod.Get, _manifestUri);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true, NoStore = true };
        request.Headers.UserAgent.ParseAdd("SWIR-Desktop-Update/0.5");

        HttpResponseMessage response;
        try { response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutCts.Token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { throw new UpdateSecurityException("UPDATE_MANIFEST_TIMEOUT", "Update manifest request timed out."); }
        catch (HttpRequestException) { throw new UpdateSecurityException("UPDATE_MANIFEST_DOWNLOAD_FAILED", "Update manifest request failed."); }

        using (response)
        {
            if ((int)response.StatusCode is 301 or 302 or 303 or 307 or 308)
                throw new UpdateSecurityException("UPDATE_MANIFEST_REDIRECT_BLOCKED", "Update manifest redirects are not allowed.");
            if (response.StatusCode != HttpStatusCode.OK)
                throw new UpdateSecurityException("UPDATE_MANIFEST_HTTP_STATUS", $"Manifest server returned HTTP {(int)response.StatusCode}.");
            if (response.Content.Headers.ContentLength is > MaxManifestBytes)
                throw new UpdateSecurityException("UPDATE_MANIFEST_SIZE_INVALID", "Update manifest exceeds the maximum allowed size.");

            await using var stream = await response.Content.ReadAsStreamAsync(timeoutCts.Token).ConfigureAwait(false);
            using var memory = new MemoryStream();
            var buffer = new byte[16 * 1024];
            while (true)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(), timeoutCts.Token).ConfigureAwait(false);
                if (read == 0) break;
                if (memory.Length + read > MaxManifestBytes)
                    throw new UpdateSecurityException("UPDATE_MANIFEST_SIZE_INVALID", "Update manifest exceeds the maximum allowed size.");
                memory.Write(buffer, 0, read);
            }
            var json = Encoding.UTF8.GetString(memory.ToArray());
            return _broker.VerifyManifest(json, currentVersion, channel);
        }
    }

    private static void ValidateManifestUri(Uri uri, HashSet<string> allowedHosts)
    {
        if (!uri.IsAbsoluteUri || !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) || !uri.IsDefaultPort || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Fragment))
            throw new UpdateSecurityException("UPDATE_MANIFEST_URL_INVALID", "Manifest URL must be a canonical HTTPS URL.");
        if (allowedHosts.Count == 0 || !allowedHosts.Contains(uri.Host))
            throw new UpdateSecurityException("UPDATE_MANIFEST_HOST_DENIED", "Manifest host is not trusted by Desktop Host policy.");
    }

    private static HttpClient CreateDefaultClient()
    {
        var handler = new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false, PreAuthenticate = false, AutomaticDecompression = DecompressionMethods.None };
        return new HttpClient(handler, true) { Timeout = Timeout.InfiniteTimeSpan };
    }

    public void Dispose() { if (_ownsClient) _http.Dispose(); }
}
