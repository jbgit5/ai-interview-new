# Copy this file to .deploy-config.ps1 and edit Host if needed.
# Do not commit the real .deploy-config.ps1 file.
$DeployConfig = @{
    Host               = 'REPLACE_WITH_EC2_PUBLIC_IP_OR_DNS'
    User               = 'ubuntu'
    SshKeyPath         = (Join-Path $HOME 'Downloads\screeno-key.pem')
    RemoteDeployScript = '/home/ubuntu/apps/deploy-screeno.sh'
    PublicUrl          = 'https://screeno-ai.duckdns.org/'
    CheckPublicUrl     = $true
}
