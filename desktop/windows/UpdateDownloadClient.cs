using System.Net;
using System.Net.Http.Headers;

namespace Swir.Desktop.Host;

internal sealed class UpdateDownloadClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly UpdateStagingBroker _staging;
    private readonly TimeSpan _timeout;
    private readonly bool _ownsClient;

    public UpdateDownloadClient(UpdateStagingBroker staging, TimeSpan? timeout = null)
        : this(staging, CreateDefaultClient(), timeout, ownsClient: true)
    {
    }

    internal UpdateDownloadClient(UpdateStagingBroker staging, HttpClient httpClient, TimeSpan? timeout = null, bool ownsClient = false)
    {
        _staging = staging ?? throw new ArgumentNullException(nameof(staging));
        _http = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _timeout = timeout ?? TimeSpan.FromMinutes(5);
        if (_timeout <= TimeSpan.Zero || _timeout > TimeSpan.FromMinutes(30))
            throw new UpdateSecurityException("UPDATE_DOWNLOAD_TIMEOUT_INVALID", "Update download timeout is outside the allowed range.");
        _ownsClient = ownsClient;
    }

    public async Task<UpdateStagingBroker.StagedUpdate> DownloadAndStageAsync(
        UpdateBroker.VerifiedUpdate update,
        CancellationToken cancellationToken = default)
    {
        if (update is null) throw new ArgumentNullException(nameof(update));
        ValidateVerifiedUri(update.PackageUri);
        if (update.Size is <= 0 or > UpdateBroker.MaxPackageBytes)
            throw new UpdateSecurityException("UPDATE_PACKAGE_SIZE_INVALID", "Signed update package size is outside the allowed range.");

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(_timeout);

        using var request = new HttpRequestMessage(HttpMethod.Get, update.PackageUri);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        request.Headers.UserAgent.ParseAdd("SWIR-Desktop-Update/0.5");
        request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true, NoStore = true };

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new UpdateSecurityException("UPDATE_DOWNLOAD_TIMEOUT", "Update package download timed out.");
        }
        catch (HttpRequestException)
        {
            throw new UpdateSecurityException("UPDATE_DOWNLOAD_FAILED", "Update package download failed.");
        }

        using (response)
        {
            if (IsRedirect(response.StatusCode))
                throw new UpdateSecurityException("UPDATE_REDIRECT_BLOCKED", "Update package redirects are not allowed.");
            if (response.StatusCode != HttpStatusCode.OK)
                throw new UpdateSecurityException("UPDATE_DOWNLOAD_HTTP_STATUS", $"Update server returned HTTP {(int)response.StatusCode}.");

            var contentLength = response.Content.Headers.ContentLength;
            if (contentLength.HasValue && contentLength.Value != update.Size)
                throw new UpdateSecurityException("UPDATE_PACKAGE_SIZE_MISMATCH", "Update response length does not match signed metadata.");
            if (contentLength.HasValue && contentLength.Value > UpdateBroker.MaxPackageBytes)
                throw new UpdateSecurityException("UPDATE_PACKAGE_SIZE_INVALID", "Update response exceeds the maximum package size.");

            await using var stream = await response.Content.ReadAsStreamAsync(timeoutCts.Token).ConfigureAwait(false);
            try
            {
                return await _staging.StageAsync(stream, update, timeoutCts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new UpdateSecurityException("UPDATE_DOWNLOAD_TIMEOUT", "Update package download timed out while staging.");
            }
        }
    }

    private static HttpClient CreateDefaultClient()
    {
        var handler = new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            UseDefaultCredentials = false,
            PreAuthenticate = false,
            AutomaticDecompression = DecompressionMethods.None
        };
        return new HttpClient(handler, disposeHandler: true)
        {
            Timeout = Timeout.InfiniteTimeSpan
        };
    }

    private static void ValidateVerifiedUri(Uri uri)
    {
        if (uri is null
            || !uri.IsAbsoluteUri
            || !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || !uri.IsDefaultPort
            || !string.IsNullOrEmpty(uri.UserInfo)
            || !string.IsNullOrEmpty(uri.Fragment))
            throw new UpdateSecurityException("UPDATE_URL_INVALID", "Verified update URL is not a canonical HTTPS URL.");
    }

    private static bool IsRedirect(HttpStatusCode statusCode)
    {
        var code = (int)statusCode;
        return code is 301 or 302 or 303 or 307 or 308;
    }

    public void Dispose()
    {
        if (_ownsClient) _http.Dispose();
    }
}
