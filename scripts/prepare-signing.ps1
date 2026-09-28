$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Only run signing preparation on the disposable CI runner' }
Write-Host 'Creating release-specific exportable code-signing certificate'
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Ann Dunkin, O=Dunkin Global Advisors, OU=Software, C=US' -CertStoreLocation Cert:\CurrentUser\My -Provider 'Microsoft Software Key Storage Provider' -KeyExportPolicy Exportable -KeyProtection None -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(3)
$password = [guid]::NewGuid().ToString()
Write-Output "::add-mask::$password"
$pfx = Join-Path $env:RUNNER_TEMP 'release-signing.pfx'
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password (ConvertTo-SecureString $password -AsPlainText -Force) | Out-Null
Export-Certificate -Cert $cert -FilePath 'build/release-signing.cer' | Out-Null
# The CurrentUser Root store prompts even with certutil -f. Use the
# administrator-managed MACHINE store on this disposable GitHub runner only.
# No trust-store changes are included in the application or installer.
Write-Host 'Trusting certificate only on disposable test runner'
certutil -f -addstore Root 'build/release-signing.cer'
if ($LASTEXITCODE -ne 0) { throw 'Could not trust release certificate on test runner' }
"CSC_LINK=$pfx" >> $env:GITHUB_ENV
"CSC_KEY_PASSWORD=$password" >> $env:GITHUB_ENV
Write-Host "Certificate ready: $($cert.Thumbprint)"
