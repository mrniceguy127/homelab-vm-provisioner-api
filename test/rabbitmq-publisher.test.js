/**
 * Tests for RabbitMQ publisher
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRabbitMqPublisher, createRabbitMqPublisherFromEnv } from '../src/rabbitmq-publisher.js';

// Mock amqplib
vi.mock('amqplib', () => {
  const mockChannel = {
    checkExchange: vi.fn().mockResolvedValue(true),
    publish: vi.fn().mockReturnValue(true),
    close: vi.fn().mockResolvedValue(undefined)
  };
  
  const mockConnection = {
    createChannel: vi.fn().mockResolvedValue(mockChannel),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined)
  };
  
  return {
    default: {
      connect: vi.fn().mockResolvedValue(mockConnection)
    }
  };
});

describe('RabbitMQ Publisher', () => {
  const validConfig = {
    host: 'localhost',
    port: 3334,
    vhost: 'provisioner',
    user: 'api_user',
    password: 'api_pass',
    exchange: 'provisioner.jobs',
    routingKeyPrefix: 'host'
  };
  
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  describe('createRabbitMqPublisher', () => {
    it('should connect to RabbitMQ with correct URL', async () => {
      const amqp = await import('amqplib');
      
      await createRabbitMqPublisher(validConfig);
      
      expect(amqp.default.connect).toHaveBeenCalledWith(
        'amqp://api_user:api_pass@localhost:3334/provisioner'
      );
    });
    
    it('should URL-encode vhost in connection string', async () => {
      const amqp = await import('amqplib');
      const config = { ...validConfig, vhost: 'test/vhost' };
      
      await createRabbitMqPublisher(config);
      
      expect(amqp.default.connect).toHaveBeenCalledWith(
        'amqp://api_user:api_pass@localhost:3334/test%2Fvhost'
      );
    });
    
    it('should check exchange exists', async () => {
      const amqp = await import('amqplib');
      const mockConnection = await amqp.default.connect();
      const mockChannel = await mockConnection.createChannel();
      
      await createRabbitMqPublisher(validConfig);
      
      expect(mockChannel.checkExchange).toHaveBeenCalledWith('provisioner.jobs');
    });
    
    it('should publish job message with correct routing key', async () => {
      const amqp = await import('amqplib');
      const mockConnection = await amqp.default.connect();
      const mockChannel = await mockConnection.createChannel();
      
      const publisher = await createRabbitMqPublisher(validConfig);
      
      await publisher.publishJob({
        job_id: '123',
        job_type: 'provision_vm',
        target_host_id: 'local'
      });
      
      expect(mockChannel.publish).toHaveBeenCalledWith(
        'provisioner.jobs',
        'host.local',
        expect.any(Buffer),
        expect.objectContaining({
          persistent: true,
          contentType: 'application/json'
        })
      );
    });
    
    it('should serialize job message as JSON', async () => {
      const amqp = await import('amqplib');
      const mockConnection = await amqp.default.connect();
      const mockChannel = await mockConnection.createChannel();
      
      const publisher = await createRabbitMqPublisher(validConfig);
      
      await publisher.publishJob({
        job_id: '456',
        job_type: 'destroy_vm',
        target_host_id: 'remote'
      });
      
      const publishCall = mockChannel.publish.mock.calls[0];
      const messageBuffer = publishCall[2];
      const message = JSON.parse(messageBuffer.toString());
      
      expect(message).toEqual({
        job_id: '456',
        job_type: 'destroy_vm',
        target_host_id: 'remote'
      });
    });
    
    it('should convert job_id to string', async () => {
      const amqp = await import('amqplib');
      const mockConnection = await amqp.default.connect();
      const mockChannel = await mockConnection.createChannel();
      
      const publisher = await createRabbitMqPublisher(validConfig);
      
      await publisher.publishJob({
        job_id: 789,
        job_type: 'start_vm',
        target_host_id: 'local'
      });
      
      const publishCall = mockChannel.publish.mock.calls[0];
      const messageBuffer = publishCall[2];
      const message = JSON.parse(messageBuffer.toString());
      
      expect(message.job_id).toBe('789');
      expect(typeof message.job_id).toBe('string');
    });
    
    it('should throw error if publish fails', async () => {
      const amqp = await import('amqplib');
      const mockConnection = await amqp.default.connect();
      const mockChannel = await mockConnection.createChannel();
      mockChannel.publish.mockReturnValue(false);
      
      const publisher = await createRabbitMqPublisher(validConfig);
      
      await expect(
        publisher.publishJob({
          job_id: '999',
          job_type: 'test',
          target_host_id: 'local'
        })
      ).rejects.toThrow('Publish returned false');
    });
    
    it('should close connection and channel', async () => {
      const amqp = await import('amqplib');
      const mockConnection = await amqp.default.connect();
      const mockChannel = await mockConnection.createChannel();
      
      const publisher = await createRabbitMqPublisher(validConfig);
      await publisher.close();
      
      expect(mockChannel.close).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });
  });
  
  describe('createRabbitMqPublisherFromEnv', () => {
    const originalEnv = process.env;
    
    beforeEach(() => {
      process.env = { ...originalEnv };
    });
    
    afterEach(() => {
      process.env = originalEnv;
    });
    
    it('should create publisher from environment variables', async () => {
      process.env.QUEUE_HOST = 'rabbitmq.local';
      process.env.QUEUE_PORT = '5672';
      process.env.QUEUE_VHOST = 'test';
      process.env.QUEUE_API_USER = 'test_user';
      process.env.QUEUE_API_PASSWORD = 'test_pass';
      process.env.QUEUE_EXCHANGE = 'test.exchange';
      process.env.QUEUE_ROUTING_KEY_PREFIX = 'route';
      
      const amqp = await import('amqplib');
      
      await createRabbitMqPublisherFromEnv();
      
      expect(amqp.default.connect).toHaveBeenCalledWith(
        'amqp://test_user:test_pass@rabbitmq.local:5672/test'
      );
    });
    
    it('should throw error if QUEUE_HOST is missing', async () => {
      process.env.QUEUE_PORT = '3334';
      process.env.QUEUE_VHOST = 'provisioner';
      process.env.QUEUE_API_USER = 'user';
      process.env.QUEUE_API_PASSWORD = 'pass';
      process.env.QUEUE_EXCHANGE = 'exchange';
      process.env.QUEUE_ROUTING_KEY_PREFIX = 'prefix';
      
      await expect(
        createRabbitMqPublisherFromEnv()
      ).rejects.toThrow('Missing required RabbitMQ environment variables');
    });
    
    it('should throw error if QUEUE_API_USER is missing', async () => {
      process.env.QUEUE_HOST = 'localhost';
      process.env.QUEUE_PORT = '3334';
      process.env.QUEUE_VHOST = 'provisioner';
      process.env.QUEUE_API_PASSWORD = 'pass';
      process.env.QUEUE_EXCHANGE = 'exchange';
      process.env.QUEUE_ROUTING_KEY_PREFIX = 'prefix';
      
      await expect(
        createRabbitMqPublisherFromEnv()
      ).rejects.toThrow('Missing required RabbitMQ environment variables');
    });
    
    it('should include all missing variables in error message', async () => {
      await expect(
        createRabbitMqPublisherFromEnv()
      ).rejects.toThrow(/HOST.*PORT.*VHOST.*USER.*PASSWORD.*EXCHANGE/);
    });
  });
});
