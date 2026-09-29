/** 网关信息设置页面。 */

import { Alert, Button, Card, Descriptions, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { api } from '../api.ts'
import { Spinner } from '../components/common.tsx'
import { useAsync } from '../hooks/useAsync.ts'

const { Text } = Typography

export function GatewaySettingsPage() {
  const { data, error, loading, reload } = useAsync(() => api.settings(), [])
  return (
    <section>
      <Card
        className="page-card"
        title="网关信息"
        extra={<Button icon={<ReloadOutlined />} onClick={reload}>刷新</Button>}
      >
        {loading && <Spinner label="加载中" />}
        {error !== undefined && <Alert type="error" showIcon title={error} className="page-alert" />}
        {!loading && data !== undefined && (
          <Descriptions
            bordered
            column={{ xs: 1, sm: 1, md: 2 }}
            items={[
              { key: 'base', label: 'API Base URL', children: <Text code>{data.apiBaseUrl}</Text> },
              { key: 'host', label: '监听地址', children: <Text code>{data.host}:{data.port}</Text> },
              { key: 'database', label: '数据库', children: <Text code>{data.databasePath}</Text> },
            ]}
          />
        )}
      </Card>
    </section>
  )
}
